/**
 * Assembled-app regression: a parent-only read-only override is seeded into
 * its child log and confines a real write under a wider deployment default.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { normalizeSessionLog, scrubRequestHeaders, type NormalizeContext } from '@deepseek-ai/dsh-acp-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./subagent-inheritance-snapshots/parent-override', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const childReplay = join(fixtureDir, 'child.replay.jsonl')
const parentExpected = join(fixtureDir, 'parent.expected.jsonl')
const childExpected = join(fixtureDir, 'child.expected.jsonl')
const configPath = fileURLToPath(new URL('../subagent-inheritance.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sessionId = SessionId('subagent-inheritance-parent')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'
const task = 'Delegate the write probe to a subagent.'
let privateHome: string

beforeEach(async () => {
  privateHome = await mkdtemp(join(tmpdir(), 'dsh-inaccessible-home-'))
  await mkdir(join(privateHome, '.ssh'))
  await chmod(privateHome, 0o000)
})

afterEach(async () => {
  await chmod(privateHome, 0o700)
  await rm(privateHome, { recursive: true, force: true })
})

/** Seed a completed parent turn with the lower policy the child must inherit. */
async function seedReadOnlyParent(root: string, cwd: string): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const meta: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 1,
    cwd,
    delegationDepth: 0,
  }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 11, data: createUserMessage({ content: [{ type: 'text', text: 'Restrict this session to workspace-write.' }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'sandbox/mode', seq: 2, time: 12, data: { mode: 'workspace-write' } },
    { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  try {
    await ctx.sessionPersistence.create(meta)
    await ctx.sessionPersistence.append(sessionId, events)
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('parent-only override inheritance snapshot', () => {
  it('confines a delegated child through the assembled headless app', async () => {
    let cwd = ''
    const result = await runLoaderSmoke({
      label: 'subagent inheritance headless stream-json snapshot',
      tempDirPrefix: 'dsh-subagent-inherit-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, task],
      tsconfigPath,
      env: {
        // The primary fixture path must exist for llm-replay's config guard;
        // the override sidecar fully replaces the derived parent script.
        DSH_SNAPSHOT_FILE: replayOverride,
        DSH_SNAPSHOT_OVERRIDE: replayOverride,
        DSH_SNAPSHOT_CHILD_FILES: childReplay,
        DSH_SNAPSHOT_PROTECTED_ROOT: join(privateHome, '.ssh'),
      },
      prepare: async (runCwd) => {
        cwd = runCwd
        await mkdir(join(runCwd, 'protected'))
        await writeFile(join(runCwd, 'protected', 'credential'), 'dummy-credential')
        await seedReadOnlyParent(join(runCwd, '.sessions'), runCwd)
      },
      inspect: async (runCwd) => {
        await expect(readFile(join(runCwd, 'allowed.txt'), 'utf8')).resolves.toBe('workspace write without approval')
        // The protected credential survives the child's workspace-write
        // attempt. Without inherited lower policy the full-access default
        // would overwrite it.
        await expect(readFile(join(runCwd, 'protected', 'credential'), 'utf8')).resolves.toBe('dummy-credential')

        // Collect both persisted logs (parent resumed turn + child run).
        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        const logs = await Promise.all(files.map(async file => readFile(join(sessionsDir, file), 'utf8')))
        const headerOf = (content: string): Record<string, unknown> =>
          JSON.parse(content.split('\n')[0] ?? '{}') as Record<string, unknown>
        const parent = logs.find(content => content.includes('"subagent-inheritance-parent"'))
        const child = logs.find(content => typeof headerOf(content).parentSession === 'string')
        if (parent === undefined || child === undefined) throw new Error('missing persisted parent or child log')
        expect(parent).not.toContain('"type":"approval/asked"')
        expect(parent).not.toContain('EACCES')

        const childRecords = child.trimEnd().split('\n').map(
          line => JSON.parse(line) as Record<string, unknown>,
        )
        expect(childRecords[1]).toMatchObject({
          type: 'sandbox/mode',
          seq: 0,
          data: { mode: 'workspace-write', source: 'delegation' },
        })

        const runtimeContexts = (content: string): string[] => content.trimEnd().split('\n').flatMap((line) => {
          const record = JSON.parse(line) as {
            type?: string
            data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: unknown }> }
          }
          if (record.type !== 'user/message'
            || record.data?.source?.kind !== 'plugin'
            || record.data.source.plugin !== '@deepseek-ai/dsh-system-prompt') return []
          return record.data.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) ?? []
        })
        const policyContexts = [...runtimeContexts(parent), ...runtimeContexts(child)]
        expect(policyContexts).toHaveLength(2)
        for (const context of policyContexts) {
          expect(context).toContain('may modify files under the session workspace')
          expect(context).not.toContain('write and edit tools')
          expect(context).not.toContain('one-shot bash commands')
          expect(context).not.toContain('terminal sessions')
        }

        const context: NormalizeContext = { sessionIds: [sessionId, String(headerOf(child).id)], cwd }
        const normalizedParent = scrubRequestHeaders(normalizeSessionLog(parent, context))
        const normalizedChild = scrubRequestHeaders(normalizeSessionLog(child, context))
        if (refreshing) {
          await writeFile(parentExpected, normalizedParent)
          await writeFile(childExpected, normalizedChild)
        }
        expect(normalizedParent).toBe(await readFile(parentExpected, 'utf8'))
        expect(normalizedChild).toBe(await readFile(childExpected, 'utf8'))
        expect(normalizedChild).toContain('file access denied under workspace-write mode')
      },
    })

    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      sessionId,
      output: 'The delegated child was denied by the sandbox. PARENT_DONE',
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
