import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { createApiProxy } from '../../../packages/host/apiproxy/src/api-proxy.ts'
import { InProcessApiClient } from '../../../packages/host/apiproxy/src/fetch/client.ts'
import { toFetchHandler } from '../../../packages/host/apiproxy/src/fetch/handler.ts'
import type { SessionMcpAttachment } from '../../../packages/host/apiproxy/src/api/sessions.ts'

let root: string
const contexts: Context[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
  if (root) await rm(root, { recursive: true, force: true })
})

async function boot() {
  const ctx = new Context(); contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['sessions', SessionStore], ['agents', AgentRegistry], ['llm', LlmRuntime], ['prompt', SystemPrompt],
    ['tools', ToolRuntime], ['loop', AgentLoop], ['persistence', JsonlPersistence], ['questions', UserQuestions],
  ])
  ctx.loader.internal = { version: 'v2', async import(name: string) { return modules.get(name) } } as never
  await writeFile(join(root, 'cordis.yml'), [
    '- name: sessions', '- name: agents', '- name: llm', '- name: prompt', '  config:', '    persona: MCP fixture',
    '- name: tools', '  config:', '    mode: native', '- name: loop', '- name: questions', '- name: persistence', '  config:',
    `    root: ${JSON.stringify(join(root, 'logs'))}`, '    compression: none',
  ].join('\n') + '\n')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await ctx.loader.await()
  const api = createApiProxy(ctx, { cwd: root, defaultModelSelection: () => ({ provider: 'fixture', model: 'model' }) })
  return { ctx, client: new InProcessApiClient(toFetchHandler(api)) }
}

function value<T>(response: { result: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!response.result.ok) throw new Error(JSON.stringify(response.result.error))
  return response.result.value
}

async function endpoint() {
  const calls: string[] = []
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      if (req.headers.authorization === 'invalid') { res.writeHead(401).end(); return }
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const rpc = JSON.parse(body) as { id?: number; method: string }
      if (rpc.id === undefined) { res.writeHead(202).end(); return }
      let result: unknown
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'api-fixture', version: '1' } }
      else if (rpc.method === 'tools/list') result = { tools: [{ name: 'get_invoice', description: 'Get a fixture invoice', inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: { invoice: { type: 'string' } }, required: ['invoice'] } }] }
      else if (rpc.method === 'tools/call') {
        const invoice = String(req.headers.authorization)
        calls.push(invoice)
        result = { content: [{ type: 'text', text: JSON.stringify({ invoice }) }], structuredContent: { invoice } }
      } else result = {}
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })().catch((error: unknown) => { res.writeHead(500).end(String(error)) })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const attachment: SessionMcpAttachment = { version: 1, transport: 'streamable-http', serverName: 'api_vxapp', url: `http://127.0.0.1:${address.port}/v2/Ai/Mcp`, headers: { Authorization: 'tenant-a' }, toolCallTimeoutMs: 1000, failOnStartupError: true }
  return { attachment, calls }
}

it('discovers through HTTP, isolates same-named session attachments, runs a tool and requires explicit reattachment after restart', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-mcp-'))
  const { attachment, calls } = await endpoint()
  const { ctx, client } = await boot()
  expect(value(await client.host.describe({})).mcpAttachmentVersions).toEqual([1])
  const id = SessionId('mcp-a')
  const created = value(await client.sessions.create({ sessionId: id, mcpAttachment: attachment }))
  expect(created.mcpAttachment).toEqual({ version: 1, serverName: 'api_vxapp', toolNames: ['mcp__api_vxapp__get_invoice'] })
  expect(value(await client.sessions.create({ sessionId: id, mcpAttachment: attachment }))).toEqual(created)
  expect((await client.sessions.create({ sessionId: id, mcpAttachment: { ...attachment, headers: { Authorization: 'changed' } } })).result).toMatchObject({ ok: false, error: { code: 'mcp-attachment-conflict' } })
  const other = SessionId('mcp-b')
  value(await client.sessions.create({ sessionId: other, mcpAttachment: { ...attachment, headers: { Authorization: 'tenant-b' } } }))
  const ordinary = value(await client.sessions.create({ sessionId: SessionId('ordinary') }))
  expect(ctx.tools.schemas(ctx.agents.get(ordinary.sessionId))).toEqual([])
  const mock = new MockAdapter([
    toolCallResponse('a', 'mcp__api_vxapp__get_invoice', {}), textResponse('Invoice A read'),
    toolCallResponse('b', 'mcp__api_vxapp__get_invoice', {}), textResponse('Invoice B read'),
  ])
  ctx.llm.registerAdapter(['fixture'], mock)
  for (const sessionId of [id, other]) {
    const agent = ctx.agents.get(sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Get my invoice' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  expect(mock.requests[1]!.messages.filter(message => message.role === 'tool')).toMatchSnapshot()
  expect(calls).toEqual(['tenant-a', 'tenant-b'])
  expect(JSON.stringify(mock.requests[1]?.messages)).toContain('tenant-a')
  expect(JSON.stringify(mock.requests[3]?.messages)).toContain('tenant-b')
  expect(JSON.stringify(mock.requests[1]?.messages)).not.toContain('tenant-b')
  await ctx.sessions.flush(ctx.agents.get(id)!.session)
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  const resumed = await boot()
  expect((await resumed.client.sessions.create({ sessionId: id })).result).toMatchObject({
    ok: false, error: { code: 'mcp-attachment-required' },
  })
  const restored = value(await resumed.client.sessions.create({ sessionId: id, mcpAttachment: attachment }))
  expect(restored.mcpAttachment).toEqual(created.mcpAttachment)
  expect(calls).toEqual(['tenant-a', 'tenant-b'])
})

it('fails creation on authentication error and rejects unsupported attachment inputs', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-session-mcp-'))
  const { attachment, calls } = await endpoint()
  const { ctx, client } = await boot()
  const id = SessionId('failed')
  expect((await client.sessions.create({ sessionId: id, mcpAttachment: { ...attachment, headers: { Authorization: 'invalid' } } })).result).toMatchObject({ ok: false, error: { code: 'mcp-attachment-failed' } })
  expect(ctx.agents.get(id)).toBeUndefined()
  expect(calls).toEqual([])
  expect((await client.sessions.create({ mcpAttachment: { ...attachment, version: 2 } as never })).result.ok).toBe(false)
  expect((await client.sessions.create({ mcpAttachment: { ...attachment, url: 'file:///tmp/mcp' } })).result.ok).toBe(false)
})
