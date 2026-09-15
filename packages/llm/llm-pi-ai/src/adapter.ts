/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * Credentials stay outside that collection. The harness resolves a route's key
 * through its own seam and passes it as the request's `apiKey` option, which
 * pi-ai treats as the highest-priority auth override — so `Models` never holds
 * a credential store and the harness keeps its fail-loud reference semantics.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The configured profiles this collection was built from, used as its identity. */
  sourceProfiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Effective profiles, including endpoint-refreshed catalogs. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
  /** Routes already refreshed from their endpoint in this snapshot. */
  refreshed: ReadonlySet<string>
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /** Rebuild one opt-in profile from the models its endpoint currently advertises. */
  refreshModels?: (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
    signal?: AbortSignal,
  ) => Promise<ResolvedPiAiProviderProfile>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** Observe one catalog-managed inference attempt without affecting its transport. */
  onInferenceOperation?: (detail: {
    operationId: string
    provider: string
    model: string
    contextWindow: number
    mode?: string
    options?: Readonly<Record<string, string | number | boolean>>
    workerConfigIdentity?: string
    sessionId?: string
    phase: 'started' | 'settled'
    outcome?: 'completed' | 'failed' | 'cancelled'
    signal: AbortSignal
  }) => void
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  expectedWorkerConfigIdentity: string | undefined,
  capacitySwap: boolean,
  requestId: string | undefined,
): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...expectedWorkerConfigIdentity === undefined
      ? {}
      : { 'X-Inf01-Expected-Worker-Identity': expectedWorkerConfigIdentity },
    ...capacitySwap ? { 'X-Inf01-Capacity-Swap': '1' } : {},
    ...requestId === undefined ? {} : { 'X-Inf01-Request-ID': requestId },
    ...attribution,
  }
}

/** Compute the backend admission identity when the catalog has a worker mode. */
function expectedWorkerIdentity(options: GenerateOptions): string | undefined {
  return options.workerConfigIdentity
}

/** A verified ready worker, read immediately before its managed request. */
interface ReadyWorker {
  model: string
  contextWindow: number
  mode: string
  options?: Readonly<Record<string, string | number | boolean>>
  identity: string
}

/** An internal marker: only scheduler transitions may be waited out. */
class WorkerTransitionError extends LlmError {}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function scalarOptions(value: unknown): Readonly<Record<string, string | number | boolean>> | undefined {
  const raw = object(value)
  if (raw === undefined) return undefined
  const entries = Object.entries(raw).flatMap(([key, entry]) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean'
    ? [[key, entry] as const]
    : [])
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function snapshotUrl(baseURL: string, model: string): string {
  const endpoint = baseURL.replace(/\/v1\/?$/, '').replace(/\/+$/, '')
  return `${endpoint}/vortex/models/snapshot?${new URLSearchParams({ model })}`
}

/**
 * Read the managed worker that owns this logical model. A reply with no row,
 * or a stopped row, is the only proof that catalog defaults may be used.
 */
async function readyWorker(
  profile: ResolvedPiAiProviderProfile,
  model: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadyWorker | undefined> {
  if (profile.modelsFromEndpoint !== true || profile.baseURL === undefined) return undefined
  let response: Response
  try {
    response = await fetch(snapshotUrl(profile.baseURL, model), {
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    if (signal?.aborted) throw new LlmError('managed worker snapshot aborted by caller', 'ABORTED', { cause: error })
    throw new LlmError('managed worker snapshot is unavailable; refusing to use catalog defaults', 'WORKER_STATE_UNAVAILABLE', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(`managed worker snapshot answered ${response.status}; refusing to use catalog defaults`, 'WORKER_STATE_UNAVAILABLE')
  }
  let payload: Record<string, unknown> | undefined
  try {
    payload = object(await response.json())
  } catch (error: unknown) {
    throw new LlmError('managed worker snapshot is invalid; refusing to use catalog defaults', 'WORKER_STATE_UNAVAILABLE', { cause: error })
  }
  const rows = Array.isArray(payload?.workers) ? payload.workers
    .map(object)
    .filter((row): row is Record<string, unknown> => row !== undefined && object(row.configured)?.model === model)
    : undefined
  if (rows === undefined) throw new LlmError('managed worker snapshot has no worker rows', 'WORKER_STATE_UNAVAILABLE')
  const worker = rows.find(row => row.state === 'ready')
  if (worker === undefined) {
    if (rows.length === 0 || rows.every(row => row.state === 'stopped' || row.state === 'idle')) return undefined
    if (rows.some(row => row.state === 'starting' || row.state === 'stopping')) {
      throw new WorkerTransitionError('managed worker state is transitioning', 'WORKER_STATE_UNAVAILABLE')
    }
    throw new LlmError('managed worker state is unavailable; refusing to use catalog defaults', 'WORKER_STATE_UNAVAILABLE')
  }
  const observed = object(worker.observed)
  const contextWindow = observed?.context
  const mode = observed?.mode
  const route = observed?.route
  const identity = observed?.worker_config_identity
  if (typeof route !== 'string' || typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0 || typeof mode !== 'string' || typeof identity !== 'string') {
    throw new LlmError('managed worker snapshot is stale; refusing to use catalog defaults', 'WORKER_STATE_UNAVAILABLE')
  }
  const options = scalarOptions(observed?.options)
  return {
    model: route as string,
    contextWindow: contextWindow as number,
    mode: mode as string,
    ...options === undefined ? {} : { options },
    identity: identity as string,
  }
}

/** Wait only for a scheduler transition; the first ready snapshot is dispatched. */
async function waitForReadyWorker(
  profile: ResolvedPiAiProviderProfile,
  model: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadyWorker | undefined> {
  try {
    return await readyWorker(profile, model, apiKey, signal)
  } catch (error: unknown) {
    if (!(error instanceof WorkerTransitionError)) throw error
  }
  while (true) {
    try {
      await sleep(250, undefined, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      if (signal?.aborted) throw new LlmError('managed worker wait aborted by caller', 'ABORTED', { cause: error })
      throw error
    }
    try {
      const worker = await readyWorker(profile, model, apiKey, signal)
      if (worker === undefined) throw new LlmError('managed worker stopped while loading', 'WORKER_LOAD_FAILED')
      return worker
    } catch (error: unknown) {
      if (error instanceof WorkerTransitionError) continue
      throw error
    }
  }
}

function sameOptions(
  left: Readonly<Record<string, string | number | boolean>> | undefined,
  right: Readonly<Record<string, string | number | boolean>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value], index) => key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1])
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.sourceProfiles === profiles) return this.snapshot
    const models: MutableModels = createModels()
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    this.snapshot = { sourceProfiles: profiles, profiles, models, refreshed: new Set() }
    return this.snapshot
  }

  /** Refresh one endpoint-owned route without mutating a snapshot already held by a request. */
  private async refreshed(
    provider: string,
    force: boolean,
    model?: string,
    signal?: AbortSignal,
  ): Promise<PiAiSnapshot> {
    const snapshot = this.current()
    const profile = this.profileOf(snapshot, provider)
    if (!profile.modelsFromEndpoint || this.config.refreshModels === undefined) return snapshot
    if (!force && snapshot.refreshed.has(provider) && (model === undefined || snapshot.models.getModel(provider, model) !== undefined)) {
      return snapshot
    }
    const refreshedProfile = await this.config.refreshModels(provider, profile, signal)
    if (this.current() !== snapshot) return this.current()
    const profiles = new Map(snapshot.profiles)
    profiles.set(provider, refreshedProfile)
    const models: MutableModels = createModels()
    for (const entry of profiles.values()) models.setProvider(entry.piProvider)
    const refreshed = new Set(snapshot.refreshed)
    refreshed.add(provider)
    this.snapshot = { sourceProfiles: snapshot.sourceProfiles, profiles, models, refreshed }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const snapshot = await this.refreshed(provider, true)
    const profile = this.profileOf(snapshot, provider)
    return snapshot.models.getModels(provider).map((model) => {
      const contextRoutes = profile.contextRoutes.get(model.id)
      const state = profile.modelStates.get(model.id)
      const runtime = profile.loadModes.get(model.id)
      return {
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
        selectable: state?.selectable ?? true,
        active: state?.active ?? false,
        maxTokens: model.maxTokens,
        ...runtime?.defaultLoadMode === undefined ? {} : { defaultLoadMode: runtime.defaultLoadMode },
        ...runtime?.loadModes === undefined ? {} : { loadModes: runtime.loadModes },
        ...runtime?.loadRoutes === undefined ? {} : { loadRoutes: runtime.loadRoutes },
        ...runtime?.loaded === undefined ? {} : { loaded: runtime.loaded },
        ...state?.selectable === false ? {} : {
          contextOptions: {
            defaultContextWindow: model.contextWindow,
            contextWindows: contextRoutes === undefined
              ? [{ contextWindow: model.contextWindow, available: true }]
              : [...contextRoutes.entries()].map(([contextWindow, route]) => ({
                contextWindow,
                available: route.available,
                ...route.unavailableReason === undefined ? {} : { unavailableReason: route.unavailableReason },
              })),
          },
        },
      }
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.refreshed(provider, false, model, _signal).then(async (snapshot) => {
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      // Catalog metadata remains selectable while worker telemetry is unavailable.
      // stream() still requires a fresh, valid worker snapshot before dispatch.
      const loaded = await readyWorker(profile, model, await this.config.resolveApiKey(provider, profile), _signal)
        .catch((error: unknown) => {
          if (error instanceof LlmError && error.code === 'WORKER_STATE_UNAVAILABLE') return undefined
          throw error
        })
      const defaultLevel = describableReasoningLevel(
        resolvedModel,
        profile.reasoningDefaults.get(model) ?? profile.reasoning,
      )
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      const contextRoutes = profile.contextRoutes.get(model)
      const state = profile.modelStates.get(model)
      const runtime = profile.loadModes.get(model)
      const contexts = new Map(contextRoutes ?? [[resolvedModel.contextWindow, { model: resolvedModel.id, available: true }]])
      // A ready worker is selectable even when this capacity is best-try cold.
      if (loaded !== undefined) {
        contexts.set(loaded.contextWindow, { model: loaded.model, available: true })
      }
      const defaultContextWindow = loaded?.contextWindow ?? resolvedModel.contextWindow
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        selectable: state?.selectable ?? true,
        active: state?.active ?? false,
        maxTokens: resolvedModel.maxTokens,
        ...runtime?.defaultLoadMode === undefined ? {} : { defaultLoadMode: runtime.defaultLoadMode },
        ...runtime?.loadModes === undefined ? {} : { loadModes: runtime.loadModes },
        ...runtime?.loadRoutes === undefined ? {} : { loadRoutes: runtime.loadRoutes },
        ...loaded === undefined
          ? runtime?.loaded === undefined ? {} : { loaded: runtime.loaded }
          : { loaded: {
            contextWindow: loaded.contextWindow,
            mode: loaded.mode,
            ...loaded.options === undefined ? {} : { options: loaded.options },
            identity: loaded.identity,
          } },
        context: { contextWindow: defaultContextWindow },
        ...state?.selectable === false ? {} : {
          contextOptions: {
            defaultContextWindow,
            contextWindows: [...contexts.entries()].map(([contextWindow, route]) => ({
              contextWindow,
              available: route.available,
              ...route.unavailableReason === undefined ? {} : { unavailableReason: route.unavailableReason },
            })),
          },
        },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const snapshot = await this.refreshed(options.provider, false, options.model, options.signal)
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    const loaded = await waitForReadyWorker(profile, options.model, apiKey, options.signal)
    if (loaded !== undefined) {
      if ((options.contextWindow !== undefined && options.contextWindow !== loaded.contextWindow)
        || (options.mode !== undefined && options.mode !== loaded.mode)
        || (options.options !== undefined && !sameOptions(options.options, loaded.options))
        || (options.workerConfigIdentity !== undefined && options.workerConfigIdentity !== loaded.identity)) {
        throw new LlmError('managed worker configuration changed; adopt loaded settings or switch worker', 'WORKER_CONFIG_CONFLICT')
      }
    }
    const contextWindow = options.contextWindow ?? loaded?.contextWindow ?? model.contextWindow
    const contextRoute = profile.contextRoutes.get(options.model)?.get(contextWindow)
    const runtime = profile.loadModes.get(options.model)
    if (profile.contextRoutes.has(options.model) && contextRoute === undefined) {
      throw new LlmError(
        `pi-ai provider "${options.provider}" model "${options.model}" does not support context window ${contextWindow}`,
        'UNSUPPORTED_CONTEXT_WINDOW',
      )
    }
    // The ready worker is already serving this capacity. Its static catalog
    // route may be best-try for a cold admission, but adopting it needs no
    // best-try opt-in and remains protected by the exact worker check above.
    if (contextRoute?.available === false && loaded?.contextWindow !== contextWindow && options.bestTryContext !== true) {
      throw new LlmError(
        contextRoute.unavailableReason
          ?? `pi-ai provider "${options.provider}" model "${options.model}" context window ${contextWindow} requires best-try mode`,
        'UNAVAILABLE_CONTEXT_WINDOW',
      )
    }
    const mode = options.mode ?? loaded?.mode ?? runtime?.defaultLoadMode
    const servingOptions = options.options ?? loaded?.options ?? Object.fromEntries(
      runtime?.loadModes?.find(candidate => candidate.id === mode)?.options
        ?.flatMap(option => option.default === undefined ? [] : [[option.id, option.default] as const]) ?? [],
    )
    const loadRoute = runtime?.loadRoutes?.find(route => route.contextWindow === contextWindow
      && route.mode === mode
      && sameOptions(route.options, servingOptions))
    if (loaded === undefined && runtime?.loadRoutes !== undefined && loadRoute === undefined) {
      throw new LlmError(
        `pi-ai provider "${options.provider}" model "${options.model}" has no runtime route for the requested serving configuration`,
        'UNSUPPORTED_SERVING_CONFIGURATION',
      )
    }
    const runtimeModel = loaded === undefined && loadRoute === undefined
      ? contextRoute === undefined || contextRoute.model === model.id ? model : { ...model, id: contextRoute.model }
      : { ...model, id: loaded?.model ?? loadRoute?.model ?? model.id }
    const operationId = profile.modelsFromEndpoint === true ? randomUUID() : undefined
    const observeOperation = operationId !== undefined && options.purpose === undefined
    const workerConfigIdentity = loaded?.identity ?? expectedWorkerIdentity(options)
    let operationOutcome: 'completed' | 'failed' | 'cancelled' | undefined
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoningDefaults.get(options.model) ?? profile.reasoning,
    )
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const servingMode = runtime?.loadModes?.find(candidate => candidate.id === mode)
      if (containsImage && servingMode?.inputModalities !== undefined && !servingMode.inputModalities.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" mode "${mode}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext(options, attachments, onReplayDegrade, profile.maxRequestImageBytes)
      if (observeOperation) {
        try {
          this.config.onInferenceOperation?.({
            operationId,
            provider: options.provider,
            model: options.model,
            contextWindow,
            ...mode === undefined ? {} : { mode },
            ...Object.keys(servingOptions).length === 0 ? {} : { options: servingOptions },
            ...workerConfigIdentity === undefined ? {} : { workerConfigIdentity },
            ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
            phase: 'started',
            signal: upstream,
          })
        } catch {
          // Lifecycle observation cannot change model transport.
        }
      }
      const events = snapshot.models.streamSimple(runtimeModel, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(
          profile.headers,
          workerConfigIdentity,
          profile.modelsFromEndpoint === true,
          operationId,
        ),
      })
      const iterator = toStreamChunks(events, contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            operationOutcome ??= 'completed'
            return
          }
          if (result.value.type === 'finish') {
            operationOutcome = result.value.reason.kind === 'error'
              ? 'failed'
              : result.value.reason.kind === 'aborted' ? 'cancelled' : 'completed'
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          operationOutcome ??= 'cancelled'
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      operationOutcome = options.signal?.aborted ? 'cancelled' : 'failed'
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
      if (observeOperation) {
        try {
          this.config.onInferenceOperation?.({
            operationId,
            provider: options.provider,
            model: options.model,
            contextWindow,
            ...mode === undefined ? {} : { mode },
            ...Object.keys(servingOptions).length === 0 ? {} : { options: servingOptions },
            ...workerConfigIdentity === undefined ? {} : { workerConfigIdentity },
            ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
            phase: 'settled',
            outcome: operationOutcome ?? 'completed',
            signal: upstream,
          })
        } catch {
          // Lifecycle observation cannot change model transport.
        }
      }
    }
  }
}
