import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { closeMockServers, mockServer, textEvents } from '../../../packages/llm/llm-pi-ai/tests/mock-server.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function boot(toolNames: readonly string[]): Promise<{ ctx: Context; server: Awaited<ReturnType<typeof mockServer>> }> {
  const server = await mockServer([{
    body: JSON.stringify({ data: [{ id: 'text-only', capabilities: { tools: false } }] }),
  },
  { body: JSON.stringify({ running: [] }) },
  { body: JSON.stringify({ workers: [] }) },
  { body: JSON.stringify({ workers: [] }) },
  { events: textEvents }])
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

function assertAdvisory(agent: Agent, server: Awaited<ReturnType<typeof mockServer>>, expectedTools: readonly string[]): void {
  const turnEnd = agent.session.events.findLast(event => event.type === 'turn/end')
  expect(turnEnd).toMatchObject({
    type: 'turn/end',
    data: { reason: { kind: 'completed' } },
  })
  expect(agent.session.events.some(event => event.type === 'tool/call' || event.type === 'tool/result')).toBe(false)
  expect(server.paths.filter(path => path === '/v1/chat/completions')).toEqual(['/v1/chat/completions'])
  const request = server.requests.at(-1) as { tools?: Array<{ function?: { name?: string } }> } | undefined
  const tools = request?.tools
  expect(tools?.map(tool => tool.function?.name)).toEqual(expectedTools)
}

describe('native-tool advisory entry paths', () => {
  it('forwards a standard agent request with explicit-negative metadata', async () => {
    const { ctx, server } = await boot(['write'])
    const agent = ctx.agentLoop.create(SessionId('standard-agent'), { provider: 'inf01', model: 'text-only' })

    send(agent)
    await agent.whenIdle()

    assertAdvisory(agent, server, ['write'])
  })

  it('forwards a delegated child request with explicit-negative metadata', async () => {
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

    assertAdvisory(child.agent, server, ['subagent'])
  })

  it('forwards a validation-preset request with explicit-negative metadata', async () => {
    const { ctx, server } = await boot(['read', 'glob', 'grep'])
    const validation = await ctx.agents.create({
      sessionId: SessionId('validation-agent'),
      meta: { agentPreset: 'native-validator' },
      agentOptions: { provider: 'inf01', model: 'text-only' },
    })

    send(validation.agent)
    await validation.agent.whenIdle()

    assertAdvisory(validation.agent, server, ['glob', 'grep', 'read'])
  })
})
