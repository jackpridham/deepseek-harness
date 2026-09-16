import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const NS = settingsNamespace('llm-pi-ai')

/** Minimal foreign adapter: only needs to own a route the pi-ai plugin then wants. */
class StubAdapter extends LlmAdapter {

  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Real dynamic composition mirroring the deepseek twin's harness. */
async function boot(dir: string, config: LlmPiAi.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

describe('request-level dynamic profiles', () => {
  it.each([
    { name: 'stopped worker with stale saved identity', contextWindow: 32_768, mode: 'default', options: {}, switchWorker: false, stopped: true },
    { name: 'capacity rejection', contextWindow: 32_768, mode: 'default', options: {}, switchWorker: true, rejected: true },
    { name: 'smaller context', contextWindow: 32_768, mode: 'default', options: {}, switchWorker: true },
    { name: 'larger context', contextWindow: 131_072, mode: 'default', options: {}, switchWorker: true },
    { name: 'different mode', contextWindow: 65_536, mode: 'text', options: {}, switchWorker: true },
    { name: 'different options', contextWindow: 65_536, mode: 'default', options: { cache: true }, switchWorker: true },
    { name: 'matching settings with stale saved identity', contextWindow: 65_536, mode: 'default', options: {}, switchWorker: false },
  ])('automatically admits $name using the fresh worker identity', async (selection) => {
    const route = selection.switchWorker || selection.stopped ? 'requested-route' : 'loaded-route'
    const server = await mockServer([
      { body: JSON.stringify({ data: [{
        id: 'managed-model', context_length: 65_536,
        context_windows: [32_768, 65_536, 131_072].map(context_window => ({ context_window, model: 'requested-route' })),
        load_routes: [{ model: route, context_window: selection.contextWindow, mode: selection.mode,
          options: selection.options, worker_config_identity: 'requested-config' }],
      }] }) },
      { body: JSON.stringify({ running: [] }) },
      { body: JSON.stringify({ workers: selection.stopped ? [] : [{ configured: { model: 'managed-model' }, state: 'ready',
        observed: { route: 'loaded-route', context: 65_536, mode: 'default', worker_config_identity: 'loaded-config@2' },
      }] }) },
      { body: JSON.stringify({ workers: selection.stopped ? [] : [{ configured: { model: 'managed-model' }, state: 'ready',
        observed: { route: 'loaded-route', context: 65_536, mode: 'default', worker_config_identity: 'loaded-config@2' },
      }] }) },
      selection.rejected
        ? { status: 507, body: JSON.stringify({ error: { message: 'GPU capacity is insufficient; existing workers were retained' } }) }
        : { events: textEvents },
    ])
    vi.stubEnv('INF01_TEST_KEY', 'test-key')
    const ctx = await boot(await home(), { providers: { inf01: {
      apiKeyEnv: 'INF01_TEST_KEY', api: 'openai-completions', baseURL: `${server.url}/v1`, modelsFromEndpoint: true,
    } } })
    const result = await assemble(ctx, {
      provider: 'inf01', model: 'managed-model', messages: [],
      contextWindow: selection.contextWindow, mode: selection.mode, options: selection.options,
      workerConfigIdentity: 'stale-config@1',
    })
    if (selection.rejected) {
      expect(result.finish.kind).toBe('error')
      if (result.finish.kind !== 'error') throw new Error('Expected capacity rejection')
      expect(result.finish.failure.message).toContain('GPU capacity is insufficient')
    } else {
      expect(result.finish).toEqual({ kind: 'stop' })
    }
    expect(server.requests.at(-1)).toMatchObject({ model: route })
    expect(server.headers.at(-1)).toMatchObject({
      'x-inf01-capacity-swap': '1',
    })
    expect(server.headers.at(-1)?.['x-inf01-expected-worker-identity']).toBe(selection.stopped ? undefined : 'loaded-config@2')
    expect(server.paths.filter(path => path === '/v1/chat/completions')).toHaveLength(1)
    expect(server.headers.at(-1)?.['x-inf01-switch-worker']).toBe(selection.switchWorker ? '1' : undefined)
  })

  it('uses an endpoint-owned model catalog without storing its membership', async () => {
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'INF01_KEY: live-key\n', { mode: 0o600 })
    const stoppedWorker = { body: JSON.stringify({ workers: [] }) }
    const server = await mockServer([
      {
        body: JSON.stringify({
          data: [{
            id: 'qwen-next',
            name: 'Qwen Next',
            context_length: 65_536,
            context_windows: [
              { context_window: 32_768, model: 'qwen-next--ctx-32768' },
              { context_window: 65_536, model: 'qwen-next' },
              {
                context_window: 262_144,
                model: 'qwen-next--ctx-262144-best-try',
                available: false,
                unavailable_reason: 'Requires best-try mode.',
              },
            ],
            reasoning: {
              format: 'qwen-chat-template-effort',
              default_effort: 'xhigh',
              efforts: [
                { id: 'off', name: 'Off', wire_value: null },
                { id: 'low', name: 'Low', wire_value: 'low-native' },
                { id: 'medium', name: 'Balanced', wire_value: 'medium-native' },
                { id: 'xhigh', name: 'Maximum', wire_value: 'xhigh-native' },
              ],
            },
            architecture: { input_modalities: ['text'] },
          }, {
            id: 'image-gen',
            name: 'Image Generator',
            context_length: 4096,
            selectable: false,
          }],
        }),
      },
      {
        body: JSON.stringify({
          running: [
            { model: 'qwen-next--ctx-32768', state: 'ready' },
            { model: 'image-gen', state: 'stopping' },
            { model: 42, state: 'ready' },
          ],
        }),
      },
      stoppedWorker,
      ...Array.from({ length: 4 }, () => [stoppedWorker, stoppedWorker, stoppedWorker, { events: textEvents }]).flat(),
      stoppedWorker,
      stoppedWorker, stoppedWorker, stoppedWorker, { events: textEvents },
    ])
    const ctx = await boot(dir, {
      providers: {
        inf01: {
          apiKeyEnv: 'INF01_KEY',
          api: 'openai-completions',
          baseURL: `${server.url}/v1`,
          modelsFromEndpoint: true,
        },
      },
    })

    expect(server.paths).toEqual([])
    await expect(ctx.llm.listModels('inf01')).resolves.toEqual([{
      provider: 'inf01',
      id: 'qwen-next',
      name: 'Qwen Next',
      inputModalities: ['text'],
      selectable: true,
      active: true,
      maxTokens: 32_768,
      contextOptions: {
        defaultContextWindow: 65_536,
        contextWindows: [
          { contextWindow: 32_768, available: true },
          { contextWindow: 65_536, available: true },
          { contextWindow: 262_144, available: false, unavailableReason: 'Requires best-try mode.' },
        ],
      },
    }, {
      provider: 'inf01',
      id: 'image-gen',
      name: 'Image Generator',
      inputModalities: ['text'],
      selectable: false,
      active: false,
      maxTokens: 32_768,
    }])
    const resolved = await ctx.llm.resolveModelInfo('inf01', 'qwen-next')
    expect(resolved.context).toEqual({ contextWindow: 65_536 })
    expect(resolved.contextOptions).toEqual({
      defaultContextWindow: 65_536,
      contextWindows: [
        { contextWindow: 32_768, available: true },
        { contextWindow: 65_536, available: true },
        { contextWindow: 262_144, available: false, unavailableReason: 'Requires best-try mode.' },
      ],
    })
    expect(resolved.reasoning).toEqual({
      defaultEffort: 'xhigh',
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Balanced' },
        { id: 'xhigh', name: 'Maximum' },
      ],
    })
    const prepared = await ctx.llm.resolveCallConfig({
      provider: 'inf01', model: 'qwen-next', contextWindow: 32_768,
    })
    const result = await assemble(ctx, { ...prepared, messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    let chatRequests = server.requests.filter((_, index) => server.paths[index] === '/v1/chat/completions')
    expect(chatRequests[0]).toMatchObject({ model: 'qwen-next--ctx-32768' })
    expect(chatRequests[0]).toMatchObject({
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
      reasoning_effort: 'xhigh-native',
    })
    const withoutReasoning = await ctx.llm.resolveCallConfig({
      provider: 'inf01', model: 'qwen-next', contextWindow: 32_768, reasoningEffort: ReasoningEffortId('off'),
    })
    await assemble(ctx, { ...withoutReasoning, messages: [] })
    chatRequests = server.requests.filter((_, index) => server.paths[index] === '/v1/chat/completions')
    expect(chatRequests[1]).toMatchObject({
      model: 'qwen-next--ctx-32768',
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    })
    expect(chatRequests[1]).not.toHaveProperty('reasoning_effort')
    for (const [index, id, wire] of [
      [2, 'low', 'low-native'],
      [3, 'medium', 'medium-native'],
    ] as const) {
      const call = await ctx.llm.resolveCallConfig({
        provider: 'inf01', model: 'qwen-next', contextWindow: 32_768, reasoningEffort: ReasoningEffortId(id),
      })
      await assemble(ctx, { ...call, messages: [] })
      chatRequests = server.requests.filter((_, requestIndex) => server.paths[requestIndex] === '/v1/chat/completions')
      expect(chatRequests[index]).toMatchObject({
        model: 'qwen-next--ctx-32768',
        chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
        reasoning_effort: wire,
      })
    }
    await expect(ctx.llm.resolveCallConfig({
      provider: 'inf01', model: 'qwen-next', contextWindow: 262_144,
    })).rejects.toMatchObject({ code: 'UNAVAILABLE_CONTEXT_WINDOW' })
    const bestTry = await ctx.llm.resolveCallConfig({
      provider: 'inf01', model: 'qwen-next', contextWindow: 262_144, bestTryContext: true,
    })
    await assemble(ctx, { ...bestTry, messages: [] })
    chatRequests = server.requests.filter((_, index) => server.paths[index] === '/v1/chat/completions')
    expect(chatRequests[4]).toMatchObject({ model: 'qwen-next--ctx-262144-best-try' })
    expect(server.headers.every(headers => headers.authorization === 'Bearer live-key')).toBe(true)
  })

  it('keeps binary template reasoning to one exact Off and On request', async () => {
    vi.stubEnv('BINARY_KEY', 'test-key')
    const stoppedWorker = { body: JSON.stringify({ workers: [] }) }
    const server = await mockServer([
      { body: JSON.stringify({ data: [{
        id: 'hybrid-model',
        context_length: 4096,
        reasoning: {
          format: 'qwen-chat-template',
          default_effort: 'high',
          efforts: [
            { id: 'off', name: 'Off', wire_value: null },
            { id: 'high', name: 'On', wire_value: 'enabled' },
          ],
        },
      }] }) },
      { body: JSON.stringify({ running: [] }) },
      stoppedWorker,
      ...Array.from({ length: 2 }, () => [stoppedWorker, stoppedWorker, { events: textEvents }]).flat(),
    ])
    const ctx = await boot(await home(), { providers: { local: {
      apiKeyEnv: 'BINARY_KEY', api: 'openai-completions', baseURL: `${server.url}/v1`, modelsFromEndpoint: true,
    } } })

    await expect(ctx.llm.resolveModelInfo('local', 'hybrid-model')).resolves.toMatchObject({
      reasoning: {
        defaultEffort: 'high',
        efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'On' }],
      },
    })
    for (const effort of ['off', 'high'] as const) {
      const result = await assemble(ctx, {
        provider: 'local', model: 'hybrid-model', reasoningEffort: ReasoningEffortId(effort), messages: [],
      })
      expect(result.finish).toEqual({ kind: 'stop' })
    }
    const requests = server.requests.filter((_, index) => server.paths[index] === '/v1/chat/completions')
    expect(requests[0]).toMatchObject({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    })
    expect(requests[0]).not.toHaveProperty('reasoning_effort')
    expect(requests[1]).toMatchObject({
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    })
    expect(requests[1]).not.toHaveProperty('reasoning_effort')
  })

  it('does not let local model settings invent endpoint reasoning metadata', async () => {
    const server = await mockServer([
      { body: JSON.stringify({ data: [{ id: 'plain', context_length: 4096 }] }) },
      { body: JSON.stringify({ running: [] }) },
    ])
    const ctx = await boot(await home(), { providers: { local: {
      api: 'openai-completions',
      baseURL: server.url,
      modelsFromEndpoint: true,
      models: [{ id: 'plain', reasoningEfforts: { high: 'locally-invented' } }],
    } } })

    await expect(ctx.llm.resolveModelInfo('local', 'plain')).resolves.not.toHaveProperty('reasoning')
  })

  it('rejects multiple enabled choices for a binary endpoint reasoning format', async () => {
    const server = await mockServer([{
      body: JSON.stringify({ data: [{
        id: 'inert',
        reasoning: {
          format: 'qwen-chat-template',
          default_effort: 'medium',
          efforts: [
            { id: 'low', name: 'Low', wire_value: 'fast' },
            { id: 'medium', name: 'Medium', wire_value: 'thorough' },
          ],
        },
      }] }),
    }])
    const ctx = await boot(await home(), { providers: { local: {
      api: 'openai-completions', baseURL: server.url, modelsFromEndpoint: true,
    } } })

    await expect(ctx.llm.listModels('local')).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
  })

  it.each([
    { label: 'failed', status: 500, body: '{}' },
    { label: 'malformed', status: 200, body: '{"not_running":[]}' },
  ])('keeps a valid catalog when the runtime-state request is $label', async ({ status, body }) => {
    const dir = await home()
    const server = await mockServer([
      { body: JSON.stringify({ data: [{ id: 'available', context_length: 4096 }] }) },
      { status, body },
    ])
    const ctx = await boot(dir, {
      providers: {
        local: {
          api: 'openai-completions',
          baseURL: server.url,
          modelsFromEndpoint: true,
        },
      },
    })

    await expect(ctx.llm.listModels('local')).resolves.toMatchObject([{
      id: 'available',
      active: false,
    }])
    expect(server.paths).toEqual(['/models', '/running'])
  })

  it('rejects endpoint reasoning formats that the runtime cannot apply', async () => {
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'INF01_KEY: live-key\n', { mode: 0o600 })
    const server = await mockServer([{
      body: JSON.stringify({
        data: [{
          id: 'unsafe',
          reasoning: {
            format: 'unknown-template-flag',
            default_effort: 'high',
            efforts: [{ id: 'high', name: 'High', wire_value: 'high' }],
          },
        }],
      }),
    }])
    const ctx = await boot(dir, {
      providers: {
        inf01: {
          apiKeyEnv: 'INF01_KEY',
          api: 'openai-completions',
          baseURL: server.url,
          modelsFromEndpoint: true,
        },
      },
    })

    await expect(ctx.llm.listModels('inf01')).rejects.toMatchObject({ code: 'INVALID_CATALOG' })
    expect(server.paths).toEqual(['/models', '/running'])
  })

  it('mounts bare and dormant, then registers routes the moment settings supply providers', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_DYNAMIC_KEY: pk-from-settings\nPI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    // The exact product posture: `- id: llm-pi-ai` with no config at all.
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: every installed catalog provider is configurable
    // before any route exists, each addressed inside the providers dict.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory.length).toBeGreaterThan(30)
    expect(directory).toContainEqual({
      provider: 'openai',
      displayName: 'openai',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'openai'],
      declared: false,
    })
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek'])
    await expect(ctx.llm.listModels('deepseek')).resolves.not.toHaveLength(0)

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer pk-from-settings')

    // Emptying the user layer returns the adapter to its dormant state.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('adds a provider route from settings and drops it when the user layer resets', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }])
    const ctx = await boot(dir, {
      providers: { openai: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: 'http://127.0.0.1:1/v1' } },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    await ctx.settings.update(NS, {
      providers: { deepseek: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai', 'deepseek'])

    const result = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.headers[0]?.authorization).toBe('Bearer live-key')

    // Reset the user layer: the settings-born route unregisters, the
    // composition route stays.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
    const removed = await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(removed.finish).toMatchObject({ kind: 'error', failure: { code: 'NO_ADAPTER' } })
  })

  it('rotates the per-request credential referenced by apiKeyEnv', async () => {
    vi.stubEnv('PI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'PI_DYNAMIC_KEY: pk-one\n', { mode: 0o600 })
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, {
      providers: { deepseek: { apiKeyEnv: 'PI_DYNAMIC_KEY', baseURL: server.url } },
    })

    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[0]?.authorization).toBe('Bearer pk-one')

    await ctx.credentials.set(credentialRef('PI_DYNAMIC_KEY'), 'pk-two')
    await assemble(ctx, { provider: 'deepseek', model: 'deepseek-v4-flash', messages: [] })
    expect(server.headers[1]?.authorization).toBe('Bearer pk-two')
  })

  it('re-registers routes in place when a captured retry policy changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    await ctx.settings.update(NS, {
      providers: {
        openai: {
          retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
        },
      },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('refuses a settings write this adapter could not serve, leaving its routes alone', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    // Shape-valid but unserviceable: a route the catalog does not ship and
    // that lists no models of its own. The section schema resolves the whole
    // profile set, so this is refused where it is written rather than stored
    // and then quietly disabling every route in the namespace.
    await expect(ctx.settings.update(NS, { providers: { 'not-a-real-provider': {} } }))
      .rejects.toThrow(/resolves no models/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('keeps serving its routes when a settings-born route collides with another adapter', async () => {
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'PI_LIVE_KEY: live-key\nPI_OTHER_KEY: other\n',
      { mode: 0o600 },
    )
    const server = await mockServer([{ events: textEvents }, { events: textEvents }])
    const ctx = await boot(dir, { providers: { openai: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: `${server.url}/v1` } } })
    // Another adapter owns `anthropic`; the registry must refuse to hand it over.
    ctx.llm.registerAdapter(['anthropic'], new StubAdapter())

    await ctx.settings.update(NS, {
      providers: {
        openai: { apiKeyEnv: 'PI_LIVE_KEY', baseURL: `${server.url}/v1` },
        anthropic: { apiKeyEnv: 'PI_OTHER_KEY' },
      },
    })

    // The conflicting swap was refused whole: the previous route set still
    // owns openai (an eager dispose would have dropped it), and anthropic
    // still belongs to its original adapter.
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['anthropic', 'openai'])
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])

    // Reverting to the working configuration re-applies, even though its
    // facts equal the ones the registry already holds.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['anthropic', 'openai'])
    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(server.paths).toEqual(['/v1/responses', '/v1/responses'])
  })

  it('ignores a settings document that merely reorders its provider keys', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {}, anthropic: {} } })
    const before = ctx.llm.listProviders().map(provider => provider.id)

    // Same routes, different YAML key order: nothing about the registration
    // changed, so no swap should happen at all.
    await ctx.settings.update(NS, { providers: { anthropic: {}, openai: {} } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(before)
  })
})
