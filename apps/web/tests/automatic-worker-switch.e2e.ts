import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { assemble } from '../../../packages/llm/llm-pi-ai/tests/assemble.ts'
import { textEvents } from '../../../packages/llm/llm-pi-ai/tests/mock-server.ts'
import { launchWebScaffold } from './scaffold.ts'

afterEach(() => vi.unstubAllEnvs())

it('the assembled web app switches to the chat context before streaming', async () => {
  const admissions: unknown[] = []
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'managed-model', context_length: 65_536,
        context_windows: [{ context_window: 32_768, model: 'small-route' }, { context_window: 65_536, model: 'large-route' }],
        load_routes: [{ context_window: 32_768, mode: 'default', model: 'small-route', worker_config_identity: 'small-config' }],
      }] }))
    } else if (request.url === '/running') {
      response.end(JSON.stringify({ running: [] }))
    } else if (request.url?.startsWith('/vortex/models/snapshot?')) {
      response.end(JSON.stringify({ workers: [{ configured: { model: 'managed-model' }, state: 'ready', observed: {
        context: 65_536, mode: 'default', route: 'large-route', worker_config_identity: 'large-config@2',
      } }] }))
    } else if (request.url === '/v1/chat/completions') {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        const payload = JSON.parse(body) as { model: string }
        admissions.push({ model: payload.model, switchWorker: request.headers['x-inf01-switch-worker'],
          expectedIdentity: request.headers['x-inf01-expected-worker-identity'] })
        response.setHeader('content-type', 'text/event-stream')
        response.end(textEvents.map(event => `data: ${event}\n\n`).join(''))
      })
    } else {
      response.statusCode = 404
      response.end('{}')
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const scaffold = await launchWebScaffold({})
  try {
    vi.stubEnv('WORKER_SWITCH_TEST_KEY', 'test-key')
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: { inf01: {
      api: 'openai-completions', modelsFromEndpoint: true, apiKeyEnv: 'WORKER_SWITCH_TEST_KEY',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    } } })
    const result = await assemble(scaffold.ctx, { provider: 'inf01', model: 'managed-model',
      messages: [], contextWindow: 32_768, workerConfigIdentity: 'stale-identity',
    })
    expect({ admissions, content: result.message.content, finish: result.finish }).toMatchInlineSnapshot(`
      {
        "admissions": [
          {
            "expectedIdentity": "large-config@2",
            "model": "small-route",
            "switchWorker": "1",
          },
        ],
        "content": [
          {
            "text": "hello",
            "type": "text",
          },
        ],
        "finish": {
          "kind": "stop",
        },
      }
    `)
  } finally {
    await scaffold.close()
    await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve() }))
  }
}, 120_000)
