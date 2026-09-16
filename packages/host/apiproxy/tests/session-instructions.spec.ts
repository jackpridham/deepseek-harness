import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, type SessionInstructions } from '@deepseek-ai/dsh-session'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Instructions from '@deepseek-ai/dsh-agent-instructions'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillTool from '@deepseek-ai/dsh-tool-skill'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { createApiProxy } from '../src/api-proxy.ts'
import { InProcessApiClient } from '../src/fetch/client.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'

let root: string
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
})

async function boot() {
  const ctx = new Context(); contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['agents', AgentRegistry], ['llm', LlmRuntime], ['prompt', SystemPrompt],
    ['tools', ToolRuntime], ['loop', AgentLoop], ['persistence', JsonlPersistence], ['fs', LocalFileSystem],
    ['instructions', Instructions], ['skills', SkillRegistry], ['skill-tool', SkillTool], ['questions', UserQuestions],
    ['meter', TokenMeter], ['compaction', BasicCompaction],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) { return modules.get(name) } } as never
  await writeFile(join(root, 'cordis.yml'), [
    '- name: sessions', '- name: agents', '- name: llm', '- name: prompt', '  config:', '    persona: DEFAULT BASE',
    '- name: tools', '- name: loop', '- name: questions', '- name: persistence', '  config:',
    `    root: ${JSON.stringify(join(root, 'logs'))}`, '    compression: none',
    '- name: fs', '  config:', `    cwd: ${JSON.stringify(root)}`,
    '- name: instructions', '  config:', '    maxBytes: 10000', `    dshHome: ${JSON.stringify(join(root, 'home'))}`,
    '- name: skills', '- name: skill-tool', '- name: meter', '- name: compaction', '  config:', '    auto: false',
  ].join('\n') + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()
  ctx.skills.register({ name: 'fixture-skill', description: 'CATALOG MARKER', source: 'runtime', content: 'EXPLICIT SKILL' })
  ctx.systemPrompt.context({ name: 'test:runtime', order: 1, text: 'RUNTIME MARKER' })
  const api = createApiProxy(ctx, { cwd: root, defaultModelSelection: () => ({ provider: 'fixture', model: 'model' }) })
  const client = new InProcessApiClient(toFetchHandler(api))
  return { ctx, client }
}

function value<T>(response: { result: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!response.result.ok) throw new Error(JSON.stringify(response.result.error))
  return response.result.value
}
const configured: SessionInstructions = {
  version: 1,
  systemPrompt: { base: { mode: 'replace', text: 'LITERAL {{unknown}}\nROLE' }, prepend: [{ id: 'first', text: 'FIRST' }], append: [{ id: 'evidence', text: 'SECOND' }, { id: 'format', text: 'THIRD' }] },
  contextSources: { harnessInstructions: 'off', workspaceInstructions: 'off', skillCatalog: 'off', runtimeFacts: 'off' },
}

it('composes API instructions through the real Loader, persists through compaction/resume, and isolates ordinary sessions', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-instructions-'))
  await mkdir(join(root, 'home')); await mkdir(join(root, '.git'))
  await writeFile(join(root, 'home', 'AGENTS.md'), 'HARNESS MARKER')
  await writeFile(join(root, 'AGENTS.md'), 'WORKSPACE MARKER')
  const { ctx, client } = await boot()
  expect(value(await client.host.describe({})).instructionVersions).toEqual([1])
  const id = SessionId('configured')
  expect(value(await client.sessions.create({ sessionId: id, instructions: configured })).instructionsRevision).toBe(1)
  expect(value(await client.sessions.configureInstructions({ sessionId: id, instructions: configured })).revision).toBe(1)
  expect(value(await client.sessions.create({ sessionId: id, instructions: configured })).instructionsRevision).toBe(1)
  const inspection = value(await client.sessions.getInstructions({ sessionId: id }))
  expect(inspection.instructions).toEqual(configured)
  expect(inspection.effective.systemPrompt).toMatchInlineSnapshot(`
    "FIRST

    LITERAL {{unknown}}
    ROLE

    SECOND

    THIRD"
  `)
  expect(inspection.effective.enabledContextSources).toEqual({
    harnessInstructions: false, workspaceInstructions: false, skillCatalog: false, runtimeFacts: false,
  })
  const agent = ctx.agents.get(id)!
  const mock = new MockAdapter([toolCallResponse('explicit', 'skill', { name: 'fixture-skill' }), textResponse('DONE'), textResponse('short summary'), textResponse('RESUMED')])
  ctx.llm.registerAdapter(['fixture'], mock)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Perform a task with details. '.repeat(200) }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(mock.requests, JSON.stringify(agent.session.events.filter(e => e.type === 'turn/end'))).toHaveLength(2)
  for (const req of mock.requests) {
    expect(req.system).toBe(inspection.effective.systemPrompt)
    expect(JSON.stringify(req.messages)).not.toMatch(/HARNESS MARKER|WORKSPACE MARKER|CATALOG MARKER|RUNTIME MARKER/)
  }
  expect(JSON.stringify(mock.requests[1]!.messages)).toContain('EXPLICIT SKILL')
  expect(agent.session.events.filter(e => e.type === 'session/instructions')).toHaveLength(1)
  expect(agent.session.events.find(e => e.type === 'turn/start')?.data).toMatchObject({ instructionsRevision: 1 })
  expect((await client.sessions.configureInstructions({ sessionId: id, instructions: { version: 1 } })).result.ok).toBe(false)
  expect(value(await client.sessions.configureInstructions({ sessionId: id, instructions: configured })).revision).toBe(1)
  expect(await ctx.compaction.compactNow(agent, new AbortController().signal)).not.toBeNull()
  expect(agent.session.events.some(e => e.type === 'compaction/summary')).toBe(true)
  expect(renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent)))).toBe(inspection.effective.systemPrompt)
  await ctx.sessions.flush(agent.session)
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)

  const resumed = await boot()
  const restored = value(await resumed.client.sessions.getInstructions({ sessionId: id }))
  expect(restored.instructions).toEqual(configured)
  expect(restored.revision).toBe(1)
  expect(restored.effective.systemPrompt).toBe(inspection.effective.systemPrompt)
  const resumedMock = new MockAdapter([textResponse('RESUMED'), textResponse('ORDINARY')])
  resumed.ctx.llm.registerAdapter(['fixture'], resumedMock)
  const live = resumed.ctx.agents.get(id)!
  live.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }))
  await live.whenIdle()
  expect(resumedMock.requests[0]!.system).toBe(inspection.effective.systemPrompt)
  expect(JSON.stringify(resumedMock.requests[0]!.messages)).not.toMatch(/HARNESS MARKER|WORKSPACE MARKER|CATALOG MARKER|RUNTIME MARKER/)
  const ordinary = value(await resumed.client.sessions.create({ sessionId: SessionId('ordinary') }))
  const normal = resumed.ctx.agents.get(ordinary.sessionId)!
  normal.followup(createUserMessage({ content: [{ type: 'text', text: 'Normal task' }], source: { kind: 'user' } }))
  await normal.whenIdle()
  expect(resumedMock.requests[1]!.system).toContain('DEFAULT BASE')
  const normalMessages = JSON.stringify(resumedMock.requests[1]!.messages)
  for (const marker of ['HARNESS MARKER', 'WORKSPACE MARKER', 'CATALOG MARKER', 'RUNTIME MARKER']) expect(normalMessages).toContain(marker)
  expect(normal.session.getInstructions()).toEqual({ revision: 0, instructions: null })
})

it('controls context sources independently and supports empty replacement and inherited base', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-instructions-sources-'))
  await mkdir(join(root, 'home')); await mkdir(join(root, '.git'))
  await writeFile(join(root, 'home', 'AGENTS.md'), 'HARNESS MARKER')
  await writeFile(join(root, 'AGENTS.md'), 'WORKSPACE MARKER')
  const { ctx, client } = await boot()
  const mock = new MockAdapter([textResponse('one'), textResponse('two')])
  ctx.llm.registerAdapter(['fixture'], mock)
  for (const [index, off, absent, present] of [
    [0, 'harnessInstructions', 'HARNESS MARKER', 'WORKSPACE MARKER'],
    [1, 'workspaceInstructions', 'WORKSPACE MARKER', 'HARNESS MARKER'],
  ] as const) {
    const id = SessionId(`source-${index}`)
    const instructions: SessionInstructions = { version: 1, contextSources: { [off]: 'off' } }
    value(await client.sessions.create({ sessionId: id, instructions }))
    const agent = ctx.agents.get(id)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'A task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const text = JSON.stringify(mock.requests[index]!.messages)
    expect(text).not.toContain(absent); expect(text).toContain(present)
  }
  const id = SessionId('fresh')
  value(await client.sessions.create({ sessionId: id }))
  const initial: SessionInstructions = { version: 1, systemPrompt: { base: { mode: 'inherit' }, prepend: [{ id: 'before', text: 'BEFORE' }], append: [{ id: 'after', text: 'AFTER' }] } }
  expect(value(await client.sessions.configureInstructions({ sessionId: id, instructions: initial })).revision).toBe(1)
  let effective = value(await client.sessions.getInstructions({ sessionId: id })).effective
  expect(effective.systemPrompt.startsWith('BEFORE\n\n')).toBe(true)
  expect(effective.systemPrompt).toContain('DEFAULT BASE'); expect(effective.systemPrompt.endsWith('\n\nAFTER')).toBe(true)
  expect(value(await client.sessions.configureInstructions({ sessionId: id, instructions: { version: 1, systemPrompt: { base: { mode: 'replace', text: '' }, prepend: [], append: [] } } })).revision).toBe(2)
  effective = value(await client.sessions.getInstructions({ sessionId: id })).effective
  expect(effective.systemPrompt).toBe('')
})
