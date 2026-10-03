import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { agentProfileDigest } from '@deepseek-ai/dsh-agent-presets'
import type { AgentProfileDefinition } from '@deepseek-ai/dsh-agent-presets/types'
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
  vi.unstubAllEnvs()
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
  const handler = toFetchHandler(api)
  return { ctx, handler, client: new InProcessApiClient({ ...handler, async fetch(...args: Parameters<typeof handler.fetch>) {
    const response = await handler.fetch(...args)
    if (response.status >= 500) throw new Error(await response.text())
    return response
  } }) }
}

async function installNative(handler: ReturnType<typeof toFetchHandler>, profile: AgentProfileDefinition) {
  const ref = { id: profile.id, version: profile.version, digest: agentProfileDigest(profile) }
  const response = await handler.fetch(new Request('http://localhost/api/agentPreset.installProfile', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test-native-installer' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'install-native', method: 'agentPreset.installProfile', payload: { profile, digest: ref.digest } }),
  }))
  expect(response.status).toBe(200)
  expect(value(await response.json() as { result: { ok: true; value: unknown } })).toEqual({ profile: ref, created: true })
  return ref
}

it('installs native tools through the profile API, isolates private state and recovers without replay', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-native-profile-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DSH_PROFILE_INSTALL_TOKEN', 'test-native-installer')
  vi.stubEnv('DSH_ALLOW_NATIVE_TOOLS', '1')
  const { ctx, handler, client } = await boot()
  const source = `import { readFile, writeFile } from 'node:fs/promises';
export function createTools({stateDirectory, binding}) {
  return [{name:'remember',description:'Remember a word and return the previous word',
    parameters:{type:'object',properties:{word:{type:'string'}},required:['word'],additionalProperties:false},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    async execute({word}) {
      let previous = 'empty';
      try { previous = await readFile(stateDirectory+'/word','utf8') } catch(e) { if(e.code!=='ENOENT') throw e }
      await writeFile(stateDirectory+'/word',word,{mode:0o600});
      return previous;
    }}];
}`
  const profile: AgentProfileDefinition = { schemaVersion: 2, id: 'native-fixture', version: '1', systemPrompt: 'Use the supplied tools.', tools: { native: { source, toolNames: ['remember'] }, mcp: [] } }
  const ref = await installNative(handler, profile)
  const binding = { tenant: 'private-tenant', user: 'private-user', conversation: 'a' }
  const id = SessionId('native-a')
  const payload = { sessionId: id, agentProfile: ref, nativeToolBinding: binding }
  const created = value(await client.sessions.create(payload))
  expect(created.agentProfile?.toolNames).toEqual(['remember'])
  expect(created.policy?.id).toBe('managed-agent-profile-v2')
  expect(value(await client.sessions.create(payload))).toEqual(created)
  expect((await client.sessions.create({ ...payload, nativeToolBinding: { ...binding, user: 'different' } })).result).toMatchObject({ ok: false, error: { code: 'agent-profile-conflict' } })
  expect((await client.sessions.create({ sessionId: id, agentProfile: ref })).result.ok).toBe(false)
  const other = SessionId('native-b')
  value(await client.sessions.create({ ...payload, sessionId: other, nativeToolBinding: { ...binding, conversation: 'b' } }))
  const mock = new MockAdapter([toolCallResponse('a', 'remember', { word: 'apple' }), textResponse('Stored'), toolCallResponse('b', 'remember', { word: 'banana' }), textResponse('Stored')])
  ctx.llm.registerAdapter(['fixture'], mock)
  for (const sessionId of [id, other]) {
    const agent = ctx.agents.get(sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Remember my word' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  expect(mock.requests[1]!.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')).toMatchSnapshot()
  expect(JSON.stringify(mock.requests)).not.toContain('private-user')
  expect(JSON.stringify(ctx.agents.get(id)!.session.events)).not.toContain('stateDirectory')
  expect(JSON.stringify(mock.requests[3]?.messages)).toContain('empty')
  await ctx.sessions.flush(ctx.agents.get(id)!.session)
  await ctx.fiber.dispose(); contexts.splice(contexts.indexOf(ctx), 1)
  const resumed = await boot()
  expect((await resumed.client.sessions.create({ ...payload, nativeToolBinding: { ...binding, tenant: 'wrong' } })).result.ok).toBe(false)
  expect(value(await resumed.client.sessions.create(payload)).agentProfile).toEqual(created.agentProfile)
  const next = new MockAdapter([toolCallResponse('c', 'remember', { word: 'cherry' }), textResponse('Stored')])
  resumed.ctx.llm.registerAdapter(['fixture'], next)
  const agent = resumed.ctx.agents.get(id)!
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Remember another word' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(next.requests[1]!.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')).toMatchSnapshot()
})

function value<T>(response: { result: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!response.result.ok) throw new Error(JSON.stringify(response.result.error))
  return response.result.value
}

it('admits an explicit MCP subset alongside native tools and rejects bad module rosters', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-mixed-profile-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubEnv('DSH_PROFILE_INSTALL_TOKEN', 'test-native-installer')
  vi.stubEnv('DSH_ALLOW_NATIVE_TOOLS', '1')
  const { ctx, handler, client } = await boot()
  const { attachment, calls } = await endpoint()
  const profile: AgentProfileDefinition = { schemaVersion: 2, id: 'mixed', version: '1', systemPrompt: 'Use the supplied tools.', tools: { native: {
    toolNames: ['echo'], source: 'export function createTools(){return [{name:\'echo\',description:\'Echo a word\',parameters:{type:\'object\',properties:{word:{type:\'string\'}},required:[\'word\'],additionalProperties:false},output:{schema:{type:\'string\'},render:(_,value)=>[{type:\'text\',text:value}]},async execute({word}){return word}}]}',
  }, mcp: ['mcp__api_vxapp__get_invoice'] } }
  const ref = await installNative(handler, profile)
  const id = SessionId('mixed')
  const payload = { sessionId: id, agentProfile: ref, nativeToolBinding: {}, mcpAttachment: attachment }
  expect(value(await client.sessions.create(payload)).agentProfile?.toolNames).toEqual(['echo', 'mcp__api_vxapp__get_invoice'])
  const excluded = await installNative(handler, { ...profile, version: '2', tools: { ...profile.tools, mcp: [] } })
  const other = SessionId('excluded')
  expect(value(await client.sessions.create({ ...payload, sessionId: other, agentProfile: excluded })).agentProfile?.toolNames).toEqual(['echo'])
  const mock = new MockAdapter([
    toolCallResponse('bad-args', 'echo', { word: 'ok', extra: true }), textResponse('Rejected'),
    toolCallResponse('hidden', 'mcp__api_vxapp__get_invoice', {}), textResponse('Rejected'),
  ])
  ctx.llm.registerAdapter(['fixture'], mock)
  for (const sessionId of [id, other]) {
    const agent = ctx.agents.get(sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Try the tool' }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  expect(calls).toEqual([])
  for (const index of [1, 3]) expect(mock.requests[index]!.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')).toMatchObject([{ isError: true }])
  const broken = await installNative(handler, { ...profile, version: 'bad', tools: { native: { ...profile.tools.native, toolNames: ['missing'] }, mcp: [] } })
  expect((await client.sessions.create({ ...payload, sessionId: SessionId('bad-module'), agentProfile: broken })).result).toMatchObject({ ok: false, error: { code: 'agent-profile-invalid' } })
  expect(ctx.agents.get(SessionId('bad-module'))).toBeUndefined()
})

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
  expect(mock.requests[1]!.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')).toMatchSnapshot()
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

async function transferEndpoint() {
  const longId = 'x'.repeat(110) + 'y'.repeat(32) + 'z'.repeat(10)
  const row = { id: longId, owner: 'α😀e\u0301', nested: [{ 'a/b~c': null }], cursor: 'cursor\\\u0000\"', padding: 'p'.repeat(5000) }
  const calls: { name: string; arguments: unknown }[] = []
  const state = { revoked: false, lost: false, pause: false, started: () => {} }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return }
      let body = ''; for await (const chunk of req) body += String(chunk)
      const rpc = JSON.parse(body) as { id?: number; method: string; params: { name: string; arguments: unknown } }
      if (rpc.id === undefined) { res.writeHead(202).end(); return }
      let result: unknown = {}
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'transfer-fixture', version: '1' } }
      if (rpc.method === 'tools/list') result = { tools: ['search', 'read', 'excluded', 'plain', 'failed', 'mutate'].map(name => ({ name, description: name,
        inputSchema: name === 'read' ? { type: 'object', properties: { id: { type: 'string', minLength: 152, maxLength: 152 }, owner: { type: 'string' }, nullable: { type: 'null' }, cursor: { type: 'string' } }, required: ['id', 'owner'], additionalProperties: false } : { type: 'object' },
      })) }
      if (rpc.method === 'tools/call') {
        if (state.revoked) { res.writeHead(403).end(); return }
        calls.push(rpc.params)
        if (state.pause) { state.started(); return }
        if (rpc.params.name === 'mutate' && state.lost) { req.socket.destroy(); return }
        result = rpc.params.name === 'plain' ? { content: [{ type: 'text', text: '{"id":"display-only"}' }] }
          : rpc.params.name === 'failed' ? { isError: true, content: [{ type: 'text', text: 'failed' }], structuredContent: { id: 'unusable' } }
            : { content: [{ type: 'text', text: 'Rendered text deliberately omits canonical values.' }], structuredContent: rpc.params.name === 'search' ? { messages: [{ id: 'decoy' }, row] } : { ok: true } }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
    })().catch(() => res.writeHead(500).end())
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port')
  return { row, calls, state, attachment: { version: 1 as const, transport: 'streamable-http' as const, serverName: 'fixture', url: `http://127.0.0.1:${address.port}/mcp`, headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true as const } }
}

it('transfers canonical MCP fields through admitted execution, persists references and never replays lost mutations', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-result-transfer-'))
  vi.stubEnv('DSH_HOME', root); vi.stubEnv('DSH_PROFILE_INSTALL_TOKEN', 'test-native-installer')
  const fixture = await transferEndpoint()
  let host = await boot()
  expect(value(await host.client.host.describe({})).resultTransferVersions).toEqual([1])
  const profile: AgentProfileDefinition = { schemaVersion: 3, id: 'transfer', version: '1', systemPrompt: 'Select values from results.', tools: {
    mcp: ['search', 'read', 'plain', 'failed', 'mutate'].map(name => `mcp__fixture__${name}`),
    resultTransfer: { version: 1, maxResults: 8, maxBytes: 65536, ttlSeconds: 60 },
  } }
  const ref = await installNative(host.handler, profile)
  const id = SessionId('transfer-a')
  const payload = { sessionId: id, agentProfile: ref, mcpAttachment: fixture.attachment, resultTransferBinding: { tenant: 'tenant-a', user: 'user-a', conversation: 'conversation-a' } }
  const created = value(await host.client.sessions.create(payload))
  expect(created.policy).toMatchObject({ id: 'managed-agent-profile-v3', attestation: { resultTransfer: 1 } })
  expect(created.agentProfile?.resultTransfer).toEqual(profile.tools.resultTransfer)
  expect(created.agentProfile?.toolNames).toEqual([...profile.tools.mcp, 'call_with_result', 'result_select'].sort())
  expect((await host.client.sessions.create({ ...payload, resultTransferBinding: { ...payload.resultTransferBinding, user: 'wrong' } })).result.ok).toBe(false)
  let reference = ''
  const findRef = (messages: unknown) => {
    const match = JSON.stringify(messages).match(/r_[a-f0-9]{24}/)
    if (!match) throw new Error('No durable reference exposed')
    return match[0]
  }
  const bindings = () => [
    { result: reference, source: '/messages/1/id', target: '/id' },
    { result: reference, source: '/messages/1/owner', target: '/owner' },
    { result: reference, source: '/messages/1/nested/0/a~1b~0c', target: '/nullable' },
    { result: reference, source: '/messages/1/cursor', target: '/cursor' },
  ]
  const script = new MockAdapter([
    toolCallResponse('search', 'mcp__fixture__search', {}),
    (request) => { reference = findRef(request.messages); return toolCallResponse('select', 'result_select', { result: reference, source: '/messages/1/nested/0/a~1b~0c' }) },
    () => toolCallResponse('copy', 'call_with_result', { tool: 'mcp__fixture__read', arguments: {}, bindings: bindings() }),
    textResponse('Transferred'),
  ])
  host.ctx.llm.registerAdapter(['fixture'], script)
  let agent = host.ctx.agents.get(id)!
  const schema = host.ctx.tools.get('call_with_result', agent)!.parameters
  expect(schema).not.toHaveProperty('$defs')
  expect(schema).toMatchObject({ properties: { arguments: { type: 'object', additionalProperties: {} } } })
  const approval: unknown[] = []
  agent.ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'mcp__fixture__read') { approval.push(exec.arguments); return { kind: 'ask' } }; return next() })
  // No approval service: target must be denied after the resolved arguments reach policy.
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Transfer fields' }], source: { kind: 'user' } })); await agent.whenIdle()
  expect(approval).toEqual([{ id: fixture.row.id, owner: fixture.row.owner, nullable: null, cursor: fixture.row.cursor }])
  expect(fixture.calls.map(call => call.name)).toEqual(['search'])
  expect(JSON.stringify(agent.session.events.filter(event => event.type === 'tool/result-reference' || event.type === 'tool/result-transfer'))).not.toContain(fixture.row.id)
  expect(JSON.parse(JSON.stringify(script.requests.at(-1)?.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')).replace(/r_[a-f0-9]{24}/g, '<result>'))).toMatchSnapshot()
  await host.ctx.sessions.flush(agent.session)
  await host.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(host.ctx), 1)
  host = await boot()
  expect((await host.client.sessions.create({ ...payload, resultTransferBinding: { ...payload.resultTransferBinding, tenant: 'foreign' } })).result.ok).toBe(false)
  value(await host.client.sessions.create(payload)); agent = host.ctx.agents.get(id)!
  expect(fixture.calls.length).toBe(1)
  const run = async (tool: string, args: object) => {
    const dispose = host.ctx.llm.registerAdapter(['fixture'], new MockAdapter([toolCallResponse(`call-${agent.session.events.length}`, tool, args), textResponse('Done')]))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run' }], source: { kind: 'user' } })); await agent.whenIdle(); dispose()
    return agent.session.events.filter(event => event.type === 'tool/result').at(-1)!
  }
  const classified: unknown[] = []
  host.ctx.tools.get('mcp__fixture__read', agent)!.isConcurrencySafe = (args) => { classified.push(args); return true }
  const args = { tool: 'mcp__fixture__read', arguments: {}, bindings: bindings() }
  const transferred = await run('call_with_result', args)
  expect(transferred.data).toMatchObject({ message: { content: [{ isError: false }] } })
  const targetRef = findRef(transferred.data)
  expect(targetRef).not.toBe(reference)
  expect(JSON.stringify((await run('result_select', { result: targetRef, source: '/ok' })).data)).toContain('true')
  const preview = await run('result_select', { result: reference, source: '' })
  expect(JSON.stringify(preview.data)).toContain('truncated')
  expect(JSON.stringify(preview.data).length).toBeLessThan(4096)
  expect(fixture.calls.at(-1)).toEqual({ name: 'read', arguments: approval[0] })
  expect(classified.length).toBeGreaterThan(0)
  expect(classified.every(args => JSON.stringify(args) === JSON.stringify(approval[0]))).toBe(true)
  const count = fixture.calls.length
  for (const bad of [
    { ...args, tool: 'mcp__fixture__excluded' }, { ...args, tool: 'call_with_result' }, { ...args, tool: 'result_select' },
    { ...args, bindings: [{ ...bindings()[0], result: 'r_000000000000000000000000' }] },
    { ...args, bindings: [{ ...bindings()[0], source: '/messages/9/id' }] },
    { ...args, arguments: { id: 'conflict' } },
    { ...args, bindings: [{ ...bindings()[0], source: '/messages/0/id' }, bindings()[1]] },
  ]) expect((await run('call_with_result', bad)).data).toMatchObject({ message: { content: [{ isError: true }] } })
  expect(fixture.calls.length).toBe(count)
  value(await host.client.sessions.create({ ...payload, sessionId: SessionId('transfer-b'), resultTransferBinding: { ...payload.resultTransferBinding, conversation: 'b' } }))
  const other = host.ctx.agents.get(SessionId('transfer-b'))!
  const saved = agent; agent = other; await run('call_with_result', args); agent = saved
  expect(fixture.calls.length).toBe(count)
  fixture.state.revoked = true; await run('call_with_result', args)
  expect(fixture.calls.length).toBe(count)
  fixture.state.revoked = false
  for (const name of ['plain', 'failed']) {
    const before = agent.session.events.filter(event => event.type === 'tool/result-reference').length
    await run(`mcp__fixture__${name}`, {})
    expect(agent.session.events.filter(event => event.type === 'tool/result-reference').length).toBe(before)
  }
  const refsBeforeCancel = agent.session.events.filter(event => event.type === 'tool/result-reference').length
  fixture.state.pause = true
  const started = new Promise<void>((resolve) => { fixture.state.started = resolve })
  const pending = run('call_with_result', args)
  await started; agent.cancel({ kind: 'user' }); await pending
  expect(agent.session.events.filter(event => event.type === 'tool/result-reference').length).toBe(refsBeforeCancel)
  fixture.state.pause = false
  fixture.state.lost = true
  await run('call_with_result', { ...args, tool: 'mcp__fixture__mutate' })
  expect(fixture.calls.filter(call => call.name === 'mutate')).toHaveLength(1)
  await host.ctx.sessions.flush(agent.session)
  await host.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(host.ctx), 1)
  host = await boot(); value(await host.client.sessions.create(payload))
  expect(fixture.calls.filter(call => call.name === 'mutate')).toHaveLength(1)
})
