import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { closeMockServers, mockServer } from '../../../packages/llm/llm-pi-ai/tests/mock-server.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function boot(toolNames: readonly string[]): Promise<{ ctx: Context; server: Awaited<ReturnType<typeof mockServer>> }> {
  const server = await mockServer([{
    body: JSON.stringify({ data: [{ id: 'text-only', capabilities: { tools: false } }] }),
  }])
  vi.stubEnv('ENTRY_PATH_KEY', 'test-key')
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmPiAi, { providers: { inf01: {
    apiKeyEnv: 'ENTRY_PATH_KEY',
    api: 'openai-completions',
    baseURL: `${server.url}/v1`,
    modelsFromEndpoint: true,
  } } })
  for (const name of toolNames) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} fixture`,
      parameters: {},
      async execute() { return [{ type: 'text', text: 'must not execute' }] },
    }))
  }
  return { ctx, server }
}

function send(agent: Agent): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Use the available tool.' }],
    source: { kind: 'user' },
  }))
}

function assertAdmission(agent: Agent, completionPaths: readonly string[]): void {
  const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
  expect(turnEnd).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: 'UNSUPPORTED_TOOLS' } } },
  })
  expect(agent.session.events.some(event => event.type === 'tool/call' || event.type === 'tool/result')).toBe(false)
  expect(completionPaths).toEqual([])
}

describe('native-tool admission entry paths', () => {
  it('rejects a standard agent at the shared Pi-AI guard', async () => {
    const { ctx, server } = await boot(['write'])
    const agent = ctx.agentLoop.create(SessionId('standard-agent'), { provider: 'inf01', model: 'text-only' })

    send(agent)
    await agent.whenIdle()

    assertAdmission(agent, server.paths.filter(path => path === '/v1/chat/completions'))
  })

  it('rejects a delegated child agent at the shared Pi-AI guard', async () => {
    const { ctx, server } = await boot(['subagent'])
    const parent = await ctx.agents.create({
      sessionId: SessionId('parent-agent'),
      agentOptions: { provider: 'inf01', model: 'text-only' },
    })
    const child = await parent.agent.ctx.agents.create({
      sessionId: SessionId('child-agent'),
      meta: { origin: 'subagent', parentSession: parent.agent.id, delegationDepth: 1 },
      agentOptions: { provider: 'inf01', model: 'text-only' },
    })

    send(child.agent)
    await child.agent.whenIdle()

    assertAdmission(child.agent, server.paths.filter(path => path === '/v1/chat/completions'))
  })

  it('rejects a validation-preset agent at the shared Pi-AI guard', async () => {
    const { ctx, server } = await boot(['read', 'glob', 'grep'])
    const validation = await ctx.agents.create({
      sessionId: SessionId('validation-agent'),
      meta: { agentPreset: 'native-validator' },
      agentOptions: { provider: 'inf01', model: 'text-only' },
    })

    send(validation.agent)
    await validation.agent.whenIdle()

    assertAdmission(validation.agent, server.paths.filter(path => path === '/v1/chat/completions'))
  })
})
