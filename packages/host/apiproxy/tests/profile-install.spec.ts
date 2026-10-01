import { afterEach, expect, it, vi } from 'vitest'
import type { ApiProxy } from '../src/api/index.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import type { RequestPayload } from '../src/api/rpc-map.ts'
import { toFetchHandler } from '../src/fetch/handler.ts'

afterEach(() => vi.unstubAllEnvs())

it('requires the backend bearer secret and refuses every browser request before parsing or dispatch', async () => {
  const installProfile = vi.fn((request: RpcRequest<RequestPayload<'agentPreset.installProfile'>>) => Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { created: true, profile: request.payload.profile } } }))
  const handler = toFetchHandler({ agentPresets: { installProfile } } as unknown as ApiProxy)
  const call = (headers: Record<string, string>, body = '{}') => handler.fetch(new Request('http://localhost/api/agentPreset.installProfile', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }))
  vi.stubEnv('DSH_PROFILE_INSTALL_TOKEN', '')
  expect((await call({})).status).toBe(403)
  vi.stubEnv('DSH_PROFILE_INSTALL_TOKEN', 'test-only-service-secret')
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer test-only-service-secret', origin: 'http://localhost' }, { authorization: 'Bearer test-only-service-secret', 'sec-fetch-site': 'same-origin' }, { authorization: 'Bearer test-only-service-secret', referer: 'http://localhost/' }]) {
    expect((await call(headers, 'not JSON')).status).toBe(403)
  }
  expect(installProfile).not.toHaveBeenCalled()
  const response = await call({ authorization: 'Bearer test-only-service-secret' }, JSON.stringify({
    type: 'client-request', rpcId: 'install', method: 'agentPreset.installProfile',
    payload: { profile: { schemaVersion: 1, id: 'assistant', version: '1', systemPrompt: 'Help.', tools: 'session-mcp' }, digest: 'sha256:' + 'a'.repeat(64) },
  }))
  expect(response.status).toBe(200)
  expect(installProfile).toHaveBeenCalledOnce()
})
