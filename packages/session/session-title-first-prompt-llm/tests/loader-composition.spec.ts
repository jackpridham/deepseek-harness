import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LlmRuntime, { createUserMessage, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-first-prompt-llm'

let root: string | undefined
let context: Context | undefined

class LoaderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      contextOptions: {
        defaultContextWindow: 131_072,
        contextWindows: [
          { contextWindow: 131_072, available: true },
          { contextWindow: 262_144, available: false, unavailableReason: 'requires best try' },
        ],
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: 'Loader composed title' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(inheritRoute = false): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-title-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 5',
    '    fallbackMaxBytes: 40',
    '    maxTitleBytes: 80',
    "- name: '@deepseek-ai/dsh-session-title-first-prompt-llm'",
    '  config:',
    '    targetWords: 5',
    '    targetCjkCharacters: 10',
    '    maxInputBytes: 1000',
    '    maxOutputTokens: 32',
    '    timeoutMs: 1000',
    ...inheritRoute ? [] : ["    provider: 'title-route'", "    model: 'title-model'"],
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-session-title-first-prompt-llm', providerPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('session-title Loader composition', () => {
  it('loads the service and one model provider with required deployment policy', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['title-route'], adapter)
    const session = ctx.sessions.create(SessionId('loader-title'))
    session.append('turn/start', {
      turn: 1,
    })
    const message = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Compose a title through Loader' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await new Promise(resolve => setTimeout(resolve, 0))
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'main-model' } },
      reason: 'initial',
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(adapter.requests[0]).toMatchObject({ provider: 'title-route', model: 'title-model' })
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Loader composed title',
      messageSeqs: [message.seq],
      source: {
        kind: 'provider',
        provider: 'session-title-first-prompt-llm',
        model: { provider: 'title-route', model: 'title-model' },
      },
    })
  })

  it('keeps the 256K main route for automatic titles and refresh after later headers change', async () => {
    const ctx = await loadComposition(true)
    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['main-route'], adapter)
    const session = ctx.sessions.create(SessionId('loader-title-context'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const route = { provider: 'main-route', model: 'main-model', contextWindow: 262_144, bestTryContext: true }
    session.append('request/header', { header: { config: route }, reason: 'initial' })
    // Automatic work must capture its triggering header before the deferred dispatch.
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'main-model', contextWindow: 131_072 } },
      reason: 'change',
    })
    await expect.poll(() => adapter.requests.length).toBe(1)
    expect(adapter.requests[0]).toMatchObject(route)
    await expect.poll(() => ctx.sessionTitle.get(session)?.source.kind).toBe('provider')
    expect(ctx.sessionTitle.get(session)?.source).toMatchObject({ model: route })
    expect(session.events.find(event => event.type === 'session/title-llm-request')?.data)
      .toMatchObject({ route })
    await ctx.sessionTitle.refresh(session)
    expect(adapter.requests[1]).toMatchObject({
      provider: 'main-route', model: 'main-model', contextWindow: 131_072,
    })
    expect(adapter.requests[1]).not.toHaveProperty('bestTryContext')
  })

})
