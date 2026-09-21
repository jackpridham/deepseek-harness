import { afterEach, expect, it } from 'vitest'
import type { Context, Model } from '@earendil-works/pi-ai'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

it.each([
  { id: 'qwen3.8-flash-next-nvfp4', active: false, history: true, emptyFallback: false },
  { id: 'qwen3.8-flash-next-nvfp4', active: true, history: true, emptyFallback: false },
  { id: 'qwen3.8-flash-next-nvfp4', active: false, history: false, emptyFallback: false },
  { id: 'claude-sonnet-4-5', active: false, history: true, emptyFallback: true },
  { id: 'anthropic/claude-sonnet-4-5', active: false, history: true, emptyFallback: true },
  { id: 'claude-sonnet-4-5', active: false, history: false, emptyFallback: false },
])('serializes $id active=$active history=$history without reopening tools', async ({ id, active, history, emptyFallback }) => {
  const server = await mockServer([{ events: textEvents }])
  const model: Model<'openai-completions'> = {
    id, name: id, api: 'openai-completions', provider: 'gateway', baseUrl: server.url,
    reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const context: Context = {
    messages: history ? [
      { role: 'assistant', api: model.api, provider: model.provider, model: id,
        content: [{ type: 'toolCall', id: 'model-call-1', name: 'closeout_json', arguments: { report: { status: 'ok' } } }],
        stopReason: 'toolUse', timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      { role: 'toolResult', toolCallId: 'model-call-1', toolName: 'closeout_json', isError: false, timestamp: 2,
        content: [{ type: 'text', text: '{"report":{"status":"ok"},"correlationId":"executor-call-1"}' }],
      },
    ] : [{ role: 'user', content: 'Return JSON.', timestamp: 1 }],
    ...(active ? { tools: [{ name: 'closeout_json', description: 'Submit report', parameters: { type: 'object' } }] } : {}),
  }
  const result = await stream(model, context, { apiKey: 'test-key', maxTokens: 8192, toolChoice: 'auto' }).result()
  expect(result.stopReason).toBe('stop')
  expect(server.paths).toEqual(['/chat/completions'])
  const body = server.requests[0] as Record<string, unknown>
  if (active) {
    expect(body.tools).toMatchObject([{ type: 'function', function: { name: 'closeout_json' } }])
    expect(body.tool_choice).toBe('auto')
  } else {
    if (emptyFallback) expect(body.tools).toEqual([])
    else expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  }
  if (history) expect(body.messages).toMatchObject([
    { role: 'assistant', tool_calls: [{ id: 'model-call-1', function: { name: 'closeout_json' } }] },
    { role: 'tool', tool_call_id: 'model-call-1', content: '{"report":{"status":"ok"},"correlationId":"executor-call-1"}' },
  ])
})
