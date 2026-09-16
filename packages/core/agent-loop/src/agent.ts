/**
 * Default Agent driver over queued turns and step-boundary input. Every request
 * is derived from the session log.
 * @module dsh-agent-loop/agent
 */

import type {
  Agent,
  AgentCancelCause,
  AgentEventDispatch,
  AgentOptions,
  AgentStatus,
  CancelOptions,
  InboxTarget,
  PreStepDecision,
  RequestErrorAction,
} from '@deepseek-ai/dsh-agent'
import { Inbox, agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, Message, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import {
  BlockAssembler,
  LlmError,
  createAssistantMessage,
  createUserMessage,
  deepFreeze,
  errorChain,
  markAgentLoopRequest,
} from '@deepseek-ai/dsh-llm'
import type { Scope } from '@deepseek-ai/dsh-scope'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { EpochHeader, RequestContext, Session, SessionEvent, SessionId, TurnEndReason, UserMessage } from '@deepseek-ai/dsh-session'
import { canonicalHeader, headerEquals } from '@deepseek-ai/dsh-session'
import { joinContextSections, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { RuntimeContextProjection } from './runtime-context.ts'
import { executeToolCalls } from './tool-calls.ts'

type Phase =
  | { kind: 'idle'; lastTurn: number }
  | {
    kind: 'maintenance'
    abort: AbortController
    lastTurn: number
    wakeRequested: boolean
  }
  | { kind: 'running'; abort: AbortController; turn: number; step: number; wakeRequested: boolean }

type StepEndReason = Extract<TurnEndReason, { kind: 'completed' | 'max-tokens' }>

/** The user-visible instruction used to resume one capped response. */
const CONTINUATION_PROMPT = 'Continue from the exact point where your previous response was cut off. Do not repeat completed content or execute incomplete tool calls.'

/** R7's confirmed maximum number of additional requests after a capped response. */
const MAX_CONTINUATIONS_PER_TURN = 3

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable output-cap recovery progress for one turn. */
    'output/continuation': {
      turn: number
      step: number
      attempt: number
      phase: 'scheduled' | 'recovered' | 'stopped'
      reason?: 'hard-cap' | 'no-progress' | 'limit' | 'error' | 'interrupted'
    }
    /** Effective allowance admitted for one assembled model request. */
    'output/budget': {
      turn: number
      step: number
      requested: number
      effective: number
      contextWindow: number
      inputTokens: number
      safetyMargin: number
      reduced?: true
    }
  }
}

type PreparedStep =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; assembly: PromptAssembly }

type LifecyclePhase = 'requesting' | 'executing' | 'completed' | 'failed'

/** Remove adapter-derived values before plugins propose the next request config. */
function requestProposal(header: EpochHeader): LlmCallConfig {
  if (header.adapterDefaults === undefined) return header.config
  const proposal = { ...header.config }
  if (header.adapterDefaults.reasoningEffort === true) delete proposal.reasoningEffort
  if (header.adapterDefaults.maxTokens === true) delete proposal.maxTokens
  return proposal
}

/** Drives one session through turn and step boundaries. */
export class ReactLoopAgent implements Agent {
  readonly inbox: Inbox
  private phase: Phase
  private activityDone: Promise<void> = Promise.resolve()

  /** The agent-scoped registration boundary; the lifecycle owner unwinds it after the driver exits. */
  readonly scope: Scope
  readonly ctx: Context

  /** Fused dispatcher, built once in the constructor so hot-path dispatches never allocate. */
  private readonly dispatch: AgentEventDispatch

  /** Whether this loop instance has appended its initial/resume request anchor. */
  private requestHeaderLogged = false
  private readonly runtimeContext: RuntimeContextProjection

  constructor(
    private loopCtx: Context,
    public readonly id: SessionId,
    public readonly options: AgentOptions,
    public readonly session: Session,
  ) {
    this.dispatch = agentEvents(loopCtx, this)
    this.inbox = new Inbox(session, {
      inserted: (message) => { this.dispatch.emit('agent/inbox/inserted', { message }) },
      discarded: (message) => { this.dispatch.emit('agent/inbox/discarded', { message }) },
      claimed: (message, turn) => { this.dispatch.emit('agent/inbox/claimed', { message, turn }) },
    })
    this.repairInterruptedContinuation()
    const lastTurn = session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.phase = { kind: 'idle', lastTurn }
    this.scope = createScope(loopCtx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.runtimeContext = new RuntimeContextProjection(this.ctx, session)
  }

  get status(): AgentStatus {
    return this.phase.kind === 'idle' || this.phase.kind === 'maintenance' ? 'idle' : 'running'
  }

  /** Terminally repair a crash-orphaned continuation instead of replaying it twice. */
  private repairInterruptedContinuation(): void {
    const latest = this.session.events.findLast((event): event is SessionEvent<'output/continuation'> =>
      event.type === 'output/continuation',
    )
    if (latest?.data.phase !== 'scheduled') return
    const ended = this.session.events.findLast((event): event is SessionEvent<'turn/end'> =>
      event.type === 'turn/end' && event.data.turn === latest.data.turn,
    )
    if (ended?.data.reason.kind !== 'interrupted') return
    const index = this.inbox.nextStep.findIndex(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'dsh-agent-loop',
    )
    if (index >= 0) this.inbox.splice('next-step', index, 1, [])
    this.session.append('output/continuation', {
      turn: latest.data.turn,
      step: latest.data.step,
      attempt: latest.data.attempt,
      phase: 'stopped',
      reason: 'interrupted',
    })
  }

  /** Commit a phase and publish its externally visible status transition. */
  private setPhase(next: Phase): void {
    const previousStatus = this.status
    this.phase = next
    const status = this.status
    if (status !== previousStatus) {
      this.dispatch.emit('agent/status', { status })
    }
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    // Waking input cannot join an aborted activity, so it starts the next turn.
    // Captured before the insertion so a reentrant cancel from a splice observer cannot reclassify it.
    const wakingAfterAbort = wakeup && this.phase.kind !== 'idle' && this.phase.abort.signal.aborted
    const resolvedTarget = wakingAfterAbort ? 'next-turn' : target
    this.inbox.splice(resolvedTarget, Infinity, 0, [message])
    if (wakeup) this.wakeDriver(wakingAfterAbort)
  }

  followup(input: UserMessage): void {
    this.send(input, 'next-turn', true)
  }

  steer(input: UserMessage): void {
    this.send(input, 'next-step', true)
  }

  inject(input: UserMessage): void {
    this.send(input, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) {
      this.inbox.clear()
      if (this.phase.kind !== 'idle') this.phase.wakeRequested = false
    }
    if (this.phase.kind !== 'idle') this.phase.abort.abort(cause)
  }

  runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.phase.kind !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const done = Promise.withResolvers<void>()
    const maintenance: Phase = {
      kind: 'maintenance',
      abort: new AbortController(),
      lastTurn: this.phase.lastTurn,
      wakeRequested: false,
    }
    this.setPhase(maintenance)
    this.activityDone = done.promise
    return (async () => {
      try {
        return await job(maintenance.abort.signal)
      } finally {
        this.setPhase({ kind: 'idle', lastTurn: maintenance.lastTurn })
        if (maintenance.wakeRequested && this.inbox.hasPending) this.wakeDriver()
        done.resolve()
      }
    })()
  }

  /**
   * Start one driver, or latch its wake behind maintenance or an aborted
   * activity. A wake sent while idle always opens its turn boundary, even
   * when its message was cleared; only a latched replay is suppressed when
   * the queue no longer holds the wake.
   * @param wakeAfterAbort - the {@link send} classification, captured before
   *   the inbox insertion so a reentrant cancel cannot reclassify it.
   */
  private wakeDriver(wakeAfterAbort = false): void {
    if (this.phase.kind !== 'idle') {
      // Maintenance and aborted drivers cannot deliver the wake: latch it for
      // replay at convergence. Live drivers claim queued work themselves;
      // disposal never latches, so teardown waits on no model turn.
      const reason = this.phase.abort.signal.reason as AgentCancelCause | undefined
      if (reason?.kind !== 'disposed' && (this.phase.kind === 'maintenance' || wakeAfterAbort)) {
        this.phase.wakeRequested = true
      }
      return
    }
    const driver = Promise.withResolvers<void>()
    this.activityDone = driver.promise
    this.setPhase({
      kind: 'running',
      abort: new AbortController(),
      turn: this.phase.lastTurn,
      step: 0,
      wakeRequested: false,
    })
    this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)
  }

  async whenIdle(): Promise<void> {
    let activity: Promise<void>
    do {
      await (activity = this.activityDone)
    } while (activity !== this.activityDone)
  }

  /** Report one failure at its live boundary, then preserve it for driver containment. */
  private throwError(error: unknown): never {
    const turn = this.phase.kind === 'running' ? this.phase.turn : this.phase.lastTurn
    const step = this.phase.kind === 'running' ? this.phase.step : 0
    this.dispatch.emit('agent/error', { turn, step, error })
    throw error
  }

  private async kick(): Promise<void> {
    try {
      while (await this.turn()) {}
    } catch (_error) {
      // Reported failures and cancellation are contained at the driver boundary.
    } finally {
      /* v8 ignore next -- kick owns a running phase until this driver boundary */
      if (this.phase.kind === 'running') {
        const { turn, wakeRequested } = this.phase
        this.setPhase({ kind: 'idle', lastTurn: turn })
        if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
      }
    }
  }

  private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
    /* v8 ignore next -- private callers establish the running phase before proposing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
    const signal = this.phase.abort.signal
    const claimed = this.inbox.claim(target, position.turn)
    const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
    signal.throwIfAborted()
    const sections = renderContextSections(assembly)
    const context = this.runtimeContext.project(joinContextSections(sections), sections)
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
  }

  /** Open one turn before claiming its first proposed step. */
  private async turn(): Promise<boolean> {
    if (this.phase.kind !== 'running') {
      this.throwError(new Error(`agent "${this.id}": turn without driver reservation`))
    }
    const phase = this.phase
    const { signal } = phase.abort
    signal.throwIfAborted()
    const turn = phase.turn + 1
    try {
      const instructionsRevision = this.session.getInstructions().revision
      this.session.append('turn/start', { turn, ...instructionsRevision === 0 ? {} : { instructionsRevision } })
    } catch (error: unknown) {
      this.throwError(error)
    }
    phase.turn = turn
    let turnEnds: TurnEndReason | null = null
    let target: InboxTarget = 'next-turn'
    try {
      while (true) {
        signal.throwIfAborted()
        const step = phase.step + 1
        const decision = await this.preStep(target, { turn, step })
        if (decision.kind === 'reject') {
          turnEnds = { kind: 'blocked' }
          return false
        }
        if (turnEnds && decision.messages.length === 0) break
        // A removed waking message or an enter decision rewritten to empty
        // still owns the initial turn boundary, but it spends no model call.
        if (phase.step === 0 && decision.messages.length === 0) {
          turnEnds = { kind: 'completed' }
          return false
        }
        signal.throwIfAborted()
        this.session.append('step/start', { turn, step })
        phase.step = step
        try {
          for (const message of decision.messages) {
            this.session.append('user/message', message, { surfaceOp: 'append' })
          }
          const stepEnd = await this.step(decision.assembly)
          // An unrecovered cap stays terminal even if independent queued work
          // later completes. A scheduled continuation returns null, so its
          // eventual successful step naturally records the real outcome.
          if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
        } finally {
          this.session.append('step/end', { turn, step })
        }
        signal.throwIfAborted()
        if (turnEnds && this.inbox.nextStep.length === 0) {
          if (turnEnds.kind === 'completed') this.completeContinuation(turn, step)
          await this.dispatch.serial('agent/turn-stopping', { turn, signal })
          signal.throwIfAborted()
        }
        if (turnEnds && this.inbox.nextStep.length === 0) break
        target = 'next-step'
      }
    } catch (error: unknown) {
      if (signal.aborted) {
        turnEnds = { kind: 'aborted', reason: signal.reason as AgentCancelCause }
        throw error
      }
      // Every failure is structured: an `LlmError` keeps its facts, anything
      // else flattens to `errorChain` text under the `UNKNOWN` code.
      turnEnds = {
        kind: 'error',
        error: error instanceof LlmError
          ? error.failure
          : { message: errorChain(error), code: 'UNKNOWN' },
      }
      this.throwError(error)
    } finally {
      try {
        // oxlint-disable-next-line typescript/no-non-null-assertion -- every exit assigns a turn ending
        this.session.append('turn/end', { turn, reason: turnEnds! })
      } catch (error: unknown) {
        this.throwError(error)
      }
    }
    if (!this.inbox.hasPending) return false
    phase.abort = new AbortController()
    // A fresh controller makes a latch set on the old one stale: the live driver claims the queue itself.
    phase.wakeRequested = false
    phase.step = 0
    return true
  }

  private async step(assembly: PromptAssembly): Promise<StepEndReason | null> {
    /* v8 ignore next -- private callers establish the running phase before executing a step */
    if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": step outside running phase`)
    const { turn, step, abort: { signal } } = this.phase
    signal.throwIfAborted()
    const system = renderPrompt(assembly)

    while (true) {
      const { request, preparedCall } = await this.buildRequest(
        turn, step, assembly.tools, system, this.session.deriveMessages(), signal,
      )
      const assembler = new BlockAssembler()
      const chunkSeqs: number[] = []
      let truncatedToolCall = false
      try {
        const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
        signal.throwIfAborted()
        let streamStarted = false
        for await (const chunk of stream) {
          signal.throwIfAborted()
          if (!streamStarted) {
            streamStarted = true
            this.observeLifecycle('executing', turn, step, request)
          }
          if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call') {
            truncatedToolCall = true
          }
          chunkSeqs.push(this.session.append('assistant/chunk', { turn, step, chunk }).seq)
          assembler.push(chunk)
        }
        signal.throwIfAborted()
      } catch (error: unknown) {
        this.observeLifecycle('failed', turn, step, request, error instanceof Error ? error.message : String(error))
        if (signal.aborted) {
          const content = assembler.interruptedBlocks()
          if (content.length > 0) {
            this.session.append('assistant/message', {
              turn,
              step,
              message: createAssistantMessage({
                content,
                source: { provider: request.provider, model: request.model },
              }),
              interrupted: true,
              ...assembler.usage === undefined ? {} : { usage: assembler.usage },
            }, { surfaceOp: 'append', sourceEventSeqs: chunkSeqs })
          }
        }
        throw error
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        this.observeLifecycle('failed', turn, step, request, finish.failure.message)
        if (this.continuationPending(turn)) {
          this.session.append('output/continuation', { turn, step, attempt: this.continuationAttempt(turn), phase: 'stopped', reason: 'error' })
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        const action = await this.dispatch.waterfall(
          'agent/request-error', {
            turn,
            step,
            provider: request.provider,
            failure: finish.failure,
            retryPolicy: preparedCall?.retryPolicy,
            signal,
          },
          () => Promise.resolve<RequestErrorAction>(undefined),
        )
        signal.throwIfAborted()
        if (action?.kind !== 'retry') {
          throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
        }
        continue
      }

      const message = createAssistantMessage({
        content: assembler.blocks(),
        source: {
          provider: request.provider,
          model: request.model,
          ...assembler.replayState !== undefined ? { replayState: assembler.replayState } : {},
        },
      })
      this.session.append(
        'assistant/message',
        {
          turn,
          step,
          message,
          ...assembler.usage === undefined ? {} : { usage: assembler.usage },
        },
        { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
      )
      this.observeLifecycle('completed', turn, step, request, finish.kind === 'max-tokens' ? 'max-tokens' : undefined)
      if (finish.kind === 'max-tokens') {
        return this.continueAfterCap(turn, step, message, truncatedToolCall) ? null : { kind: 'max-tokens' }
      }

      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      if (toolCalls.length === 0) return { kind: 'completed' }
      const { concluded } = await executeToolCalls(
        this.loopCtx, turn, step, toolCalls, signal,
        context => this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [context]),
      )
      return concluded ? { kind: 'completed' } : null
    }
  }

  /** Report real request boundaries to the host lifecycle writer when composed. */
  private observeLifecycle(
    phase: LifecyclePhase,
    turn: number,
    step: number,
    config: LlmCallConfig,
    reason?: string,
  ): void {
    const lifecycle = this.loopCtx.get('llmRequestLifecycle') as {
      observe(payload: {
        sessionId: SessionId
        turn?: number
        step?: number
        provider: string
        model: string
        contextWindow?: number
        mode?: string
        options?: Readonly<Record<string, string | number | boolean>>
        workerConfigIdentity?: string
        phase: string
        reason?: { code?: string; message?: string }
      }): void
    } | undefined
    lifecycle?.observe({
      sessionId: this.session.id,
      turn,
      step,
      provider: config.provider,
      model: config.model,
      ...config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow },
      ...config.mode === undefined ? {} : { mode: config.mode },
      ...config.options === undefined ? {} : { options: config.options },
      ...config.workerConfigIdentity === undefined ? {} : { workerConfigIdentity: config.workerConfigIdentity },
      phase,
      ...reason === undefined ? {} : { reason: { message: reason } },
    })
  }

  /** Schedule one bounded same-turn continuation without making tool fragments executable. */
  private continueAfterCap(turn: number, step: number, message: Message, truncatedToolCall: boolean): boolean {
    const prior = this.session.events.filter((event): event is SessionEvent<'output/continuation'> =>
      event.type === 'output/continuation'
      && event.data.turn === turn
      && event.data.phase === 'scheduled',
    )
    const attempt = prior.length + 1
    // AgentOptions are direct callers' hard per-request caps. A selected
    // output preference is installed through the request waterfall instead.
    if (this.options.maxTokens !== undefined) {
      this.session.append('output/continuation', { turn, step, attempt, phase: 'stopped', reason: 'hard-cap' })
      return false
    }
    if (attempt > MAX_CONTINUATIONS_PER_TURN) {
      this.session.append('output/continuation', { turn, step, attempt: prior.length, phase: 'stopped', reason: 'limit' })
      return false
    }
    const previous = this.session.deriveMessages().findLast(candidate => candidate.role === 'assistant' && candidate.id !== message.id)
    const output = message.content
      .filter((block): block is Extract<typeof block, { type: 'text' | 'reasoning' }> => block.type === 'text' || block.type === 'reasoning')
      .map(block => [block.type, block.text])
    const previousOutput = previous?.content
      .filter((block): block is Extract<typeof block, { type: 'text' | 'reasoning' }> => block.type === 'text' || block.type === 'reasoning')
      .map(block => [block.type, block.text])
    if ((!truncatedToolCall && output.length === 0) || JSON.stringify(output) === JSON.stringify(previousOutput)) {
      this.session.append('output/continuation', { turn, step, attempt, phase: 'stopped', reason: 'no-progress' })
      return false
    }
    this.session.append('output/continuation', { turn, step, attempt, phase: 'scheduled' })
    this.inbox.splice('next-step', this.inbox.nextStep.length, 0, [createUserMessage({
      content: [{ type: 'text', text: CONTINUATION_PROMPT }],
      source: { kind: 'plugin', plugin: 'dsh-agent-loop' },
    })])
    return true
  }

  /** Record recovery once the final same-turn continuation settles normally. */
  private completeContinuation(turn: number, step: number): void {
    const prior = this.session.events.findLast((event): event is SessionEvent<'output/continuation'> =>
      event.type === 'output/continuation'
      && event.data.turn === turn
      && event.data.phase === 'scheduled',
    )
    if (prior !== undefined) {
      this.session.append('output/continuation', { turn, step, attempt: prior.data.attempt, phase: 'recovered' })
    }
  }

  /** A pending continuation never enters provider retry recovery after an error. */
  private continuationPending(turn: number): boolean {
    const latest = this.session.events.findLast((event): event is SessionEvent<'output/continuation'> =>
      event.type === 'output/continuation' && event.data.turn === turn,
    )
    return latest?.data.phase === 'scheduled'
  }

  /** Return the durable current continuation count for error reporting. */
  private continuationAttempt(turn: number): number {
    return this.session.events.filter((event): event is SessionEvent<'output/continuation'> =>
      event.type === 'output/continuation' && event.data.turn === turn && event.data.phase === 'scheduled',
    ).length
  }

  /**
   * Compose one frozen request and bind it to the adapter registration that
   * resolved its exact-model defaults.
   */
  private async buildRequest(
    turn: number,
    step: number,
    tools: GenerateOptions['tools'] & object,
    system: string,
    _boundaryMessages: Message[],
    signal: AbortSignal,
  ): Promise<{ request: GenerateOptions; preparedCall?: PreparedLlmCall }> {
    const { session } = this

    // A loop instance starts from its declared route, restoring only an explicit
    // effort owned by that exact model. Later steps re-resolve marked defaults.
    const persistedHeader = session.requestHeader()
    const persistedConfig = persistedHeader?.config
    const route = { provider: this.options.provider ?? '', model: this.options.model ?? '' }
    const reasoningEffort = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      && persistedHeader?.adapterDefaults?.reasoningEffort !== true
      ? persistedConfig.reasoningEffort
      : undefined
    const selectedContextWindow = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      ? persistedConfig.contextWindow
      : undefined
    const bestTryContext = persistedConfig?.provider === route.provider
      && persistedConfig.model === route.model
      ? persistedConfig.bestTryContext
      : undefined
    const maxTokens = this.options.maxTokens
    const seedConfig = deepFreeze(structuredClone(
      this.requestHeaderLogged
        // oxlint-disable-next-line typescript/no-non-null-assertion -- the instance logged the header it now folds
        ? requestProposal(persistedHeader!)
        : {
          ...route,
          ...reasoningEffort === undefined ? {} : { reasoningEffort },
          ...selectedContextWindow === undefined ? {} : { contextWindow: selectedContextWindow },
          ...bestTryContext === undefined ? {} : { bestTryContext },
          ...maxTokens === undefined ? {} : { maxTokens },
        },
    ))
    const proposedConfig = await this.dispatch.waterfall(
      'agent/request', { turn, step, signal },
      () => Promise.resolve(seedConfig),
    )
    signal.throwIfAborted()
    if (!proposedConfig.provider || !proposedConfig.model) {
      throw new Error(`agent "${this.id}" has no provider/model: set AgentOptions.provider and AgentOptions.model or supply both via the agent/request waterfall`)
    }
    let config: LlmCallConfig
    let preparedCall: PreparedLlmCall | undefined
    try {
      preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal)
      config = preparedCall.config
    } catch (error: unknown) {
      // Middleware may serve an unregistered route; terminal dispatch still requires an adapter.
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
      config = proposedConfig
    }
    signal.throwIfAborted()

    let header = canonicalHeader({
      config,
      ...preparedCall === undefined ? {} : { adapterDefaults: preparedCall.adapterDefaults },
      ...system ? { system } : {},
      ...tools.length > 0 ? { tools } : {},
    })
    const contextWindow = preparedCall?.context?.contextWindow
    const presetServices = this.loopCtx.get('agentPresets') as {
      serviceFor(agent: ReactLoopAgent, name: 'compaction'): unknown
    } | undefined
    const meter = this.ctx.get('tokenMeter') as {
      measure(session: Session, header: EpochHeader): { totalTokens: number }
    } | undefined
    if (contextWindow !== undefined && config.maxTokens !== undefined) {
      if (meter === undefined) throw new LlmError('token meter is required for output budgeting', 'OUTPUT_BUDGET_UNAVAILABLE')
      let measurement = meter.measure(session, header)
      let available = contextWindow - measurement.totalTokens - this.loopCtx.agentLoop.config.outputSafetyMargin
      if (available < config.maxTokens) {
        // Existing compaction owns balanced history replacement. It may decline
        // when no valid checkpoint can shrink this particular request.
        const compaction = (presetServices?.serviceFor(this, 'compaction') ?? this.ctx.get('compaction')) as {
          compactForOutputBudget(
            agent: ReactLoopAgent, header: EpochHeader, contextWindow: number,
            reserveTokens: number, signal: AbortSignal,
          ): Promise<unknown>
        } | undefined
        let summaryTruncated: LlmError | undefined
        if (compaction !== undefined) {
          try {
            await compaction.compactForOutputBudget(
              this, header, contextWindow, config.maxTokens + this.loopCtx.agentLoop.config.outputSafetyMargin, signal,
            )
          } catch (error: unknown) {
            signal.throwIfAborted()
            if (!(error instanceof LlmError) || error.code !== 'COMPACTION_SUMMARY_TRUNCATED') throw error
            summaryTruncated = error
          }
        }
        measurement = meter.measure(session, header)
        available = contextWindow - measurement.totalTokens - this.loopCtx.agentLoop.config.outputSafetyMargin
        if (available <= 0 && summaryTruncated !== undefined) throw summaryTruncated
      }
      if (available <= 0) {
        throw new LlmError('no output space remains after context budgeting', 'OUTPUT_BUDGET_EXCEEDED')
      }
      const requested = config.maxTokens
      const effective = Math.min(requested, available)
      if (effective !== requested) {
        preparedCall = await this.loopCtx.llm.prepareCall({ ...config, maxTokens: effective }, signal)
        config = preparedCall.config
        header = canonicalHeader({
          config,
          adapterDefaults: preparedCall.adapterDefaults,
          ...system ? { system } : {},
          ...tools.length > 0 ? { tools } : {},
        })
      }
      session.append('output/budget', {
        turn,
        step,
        requested,
        effective,
        contextWindow,
        inputTokens: measurement.totalTokens,
        safetyMargin: this.loopCtx.agentLoop.config.outputSafetyMargin,
        ...effective < requested ? { reduced: true } : {},
      })
    }
    const baseline = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', { header, reason: baseline === undefined ? 'initial' : 'resume' })
      this.requestHeaderLogged = true
    } else if (baseline === undefined || !headerEquals(baseline, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }

    const requestContext: RequestContext = {
      provider: config.provider,
      model: config.model,
      ...contextWindow === undefined ? {} : { contextWindow },
    }
    const previousContext = session.requestContext()
    if (previousContext?.provider !== requestContext.provider
      || previousContext.model !== requestContext.model
      || previousContext.contextWindow !== requestContext.contextWindow) {
      session.append('request/context', requestContext)
    }
    signal.throwIfAborted()

    const request = markAgentLoopRequest(deepFreeze({
      ...header.config,
      messages: this.session.deriveMessages(),
      ...header.system !== undefined ? { system: header.system } : {},
      ...header.tools !== undefined ? { tools: header.tools } : {},
      sessionId: this.session.id,
      signal,
    }))
    this.observeLifecycle('requesting', turn, step, header.config)
    return { request, ...preparedCall === undefined ? {} : { preparedCall } }
  }
}
