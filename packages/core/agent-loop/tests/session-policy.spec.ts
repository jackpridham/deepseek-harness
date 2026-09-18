/** Policy admission across direct factory calls, persistence, and provider disposal. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { SessionPolicy } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionPolicyId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

const contexts: Context[] = []
const dirs: string[] = []
const id = SessionPolicyId('test-locked-v1')
const sessionId = SessionId('policy-session')

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  } finally {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  }
})

async function harness(root?: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (root !== undefined) await ctx.plugin(JsonlPersistence, { root })
  ctx.tools.register(defineContentToolFixture({
    name: 'test-tool', description: 'test', parameters: {}, execute: async () => [],
  }))
  return ctx
}

function policy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    id, workspace: false, presets: false, fork: false, attestation: { locked: true },
    apply(agent) { agent.ctx.tools.denyAllTools() },
    ...overrides,
  }
}

describe('session policy admission', () => {
  it('rejects a missing provider before announcing an agent or session', async () => {
    const ctx = await harness()
    const announced: string[] = []
    ctx.on('session/created', (session) => { announced.push(session.id) })
    await expect(ctx.agents.create({ sessionId, meta: { sessionPolicy: id } })).rejects.toThrow('is unavailable')
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])
    expect(announced).toEqual([])
  })

  it('installs policy after caller setup and before creation notifications', async () => {
    const ctx = await harness()
    ctx.agents.registerPolicy(policy())
    const seen: unknown[] = []
    ctx.on('agent/created', ({ agent }) => { seen.push(ctx.tools.schemas(agent)) })
    const handle = await ctx.agents.create({
      sessionId, meta: { sessionPolicy: id },
      setup(agentCtx) {
        agentCtx.tools.register(defineContentToolFixture({
          name: 'own-tool', description: 'own', parameters: {}, execute: async () => [],
        }))
      },
    })
    expect(seen).toEqual([[]])
    expect(ctx.tools.schemas(handle.agent)).toEqual([])
    expect(ctx.agents.policyFor(sessionId)?.id).toBe(id)
    expect(ctx.tools.schemas()).toHaveLength(1)
    await handle.dispose()
    expect(ctx.agents.policyFor(sessionId)).toBeUndefined()
  })

  it.each([
    { cwd: '/tmp', error: 'forbids cwd' },
    { agentPreset: 'standard', error: 'forbids agentPreset' },
    { parentSession: SessionId('parent'), error: 'forbids forked agents' },
  ])('rejects forbidden metadata: $error', async ({ error, ...meta }) => {
    const ctx = await harness()
    ctx.agents.registerPolicy(policy())
    await expect(ctx.agents.create({ sessionId, meta: { ...meta, sessionPolicy: id } })).rejects.toThrow(error)
    expect(ctx.sessions.list()).toEqual([])
  })

  it('rolls back publication when the provider fails', async () => {
    const ctx = await harness()
    ctx.agents.registerPolicy(policy({ apply() { throw new Error('policy setup failed') } }))
    await expect(ctx.agents.create({ sessionId, meta: { sessionPolicy: id } })).rejects.toThrow('policy setup failed')
    expect(ctx.agents.list()).toEqual([])
    expect(ctx.sessions.list()).toEqual([])
  })

  it('retains live policy assertions while provider disposal blocks future creation', async () => {
    const ctx = await harness()
    const provider = policy()
    const dispose = ctx.agents.registerPolicy(provider)
    expect(() => ctx.agents.registerPolicy(provider)).toThrow('already registered')
    const handle = await ctx.agents.create({ sessionId, meta: { sessionPolicy: id } })
    dispose()
    expect(ctx.agents.policyIds()).toEqual([])
    expect(ctx.agents.policyFor(sessionId)?.attestation).toEqual({ locked: true })
    expect(ctx.tools.schemas(handle.agent)).toEqual([])
    await expect(ctx.agents.create({ sessionId: SessionId('new'), meta: { sessionPolicy: id } })).rejects.toThrow('is unavailable')
    ctx.agents.registerPolicy(policy({ attestation: { replacement: true } }))
    expect(ctx.agents.policyFor(sessionId)?.attestation).toEqual({ locked: true })
  })

  it('requires and reinstalls the policy on a persisted resume without caller setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-policy-resume-'))
    dirs.push(root)
    const first = await harness(root)
    first.agents.registerPolicy(policy())
    const handle = await first.agents.create({
      sessionId, meta: { sessionPolicy: id },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
    await first.sessions.flush(handle.agent.session)
    await first.fiber.dispose()
    const second = await harness(root)
    await expect(second.agents.resume({ resumeSessionId: sessionId })).rejects.toThrow('is unavailable')
    expect(second.agents.list().map(agent => agent.id)).toEqual([])
    second.agents.registerPolicy(policy())
    const resumed = await second.agents.resume({ resumeSessionId: sessionId })
    expect(resumed.agent.session.header.sessionPolicy).toBe(id)
    expect(second.tools.schemas(resumed.agent)).toEqual([])
    const fork = second.sessions.fork(resumed.agent.session)
    expect(fork.header.sessionPolicy).toBe(id)
  })
})
