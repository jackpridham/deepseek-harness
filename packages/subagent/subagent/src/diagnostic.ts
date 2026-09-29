/** Diagnostic run admission and native child ownership over the central session log. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionPolicyId } from '@deepseek-ai/dsh-session'
import type { JsonValue, Session } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, MessageId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SubagentRuntime } from './index.ts'
import {
  diagnosticCanonicalJson,
  diagnosticInstructions,
  diagnosticRecordDigest,
  parseDiagnosticAdmission,
  parseDiagnosticAssignment,
  diagnosticResultSchema,
  diagnosticAdmissionSchema,
} from './diagnostic-contract.ts'
import type { DiagnosticAdmission, DiagnosticAssignment } from './diagnostic-contract.ts'

/** Required durable session policy for this opt-in workflow. */
export const DIAGNOSTIC_POLICY = SessionPolicyId('vortex-diagnostic-children-v1')

/** Public failure metadata distinguishes rejection from uncertain previously accepted work. */
export class DiagnosticError extends Error {
  /** Retry and reconciliation guidance for the rejected or uncertain operation. */
  readonly details: { retryable: false; operationState: 'not-started' | 'unknown'; reconcileWith: 'none' | 'history' }
  constructor(
    readonly code:
      | 'diagnostic-capability-unavailable'
      | 'diagnostic-policy-rejected'
      | 'diagnostic-instructions-invalid'
      | 'diagnostic-binding-stale'
      | 'diagnostic-parent-stale'
      | 'diagnostic-assignment-conflict'
      | 'diagnostic-budget-exhausted'
      | 'diagnostic-child-unsettled',
    message: string,
    uncertain = false,
  ) {
    super(message)
    this.details = {
      retryable: false,
      operationState: uncertain ? 'unknown' : 'not-started',
      reconcileWith: uncertain ? 'history' : 'none',
    }
  }
}

/** Immutable identity returned by the authoritative executor bridge. */
export interface DiagnosticBinding {
  executorBindingId: string
  bindingEpoch: number
  runId: string
  rootSessionId: string
  comparisonDigest: string
  sourceRefs: DiagnosticAdmission['sourceRefs']
  state: 'awaiting-admission' | 'active' | 'reconciling' | 'disconnected'
}

/** The bridge supplies transport and source tools; core owns all sessions and model work. */
export interface DiagnosticExecutor {
  /** Read the live authenticated binding; missing or expired attachments throw. */
  binding(root: SessionId): DiagnosticBinding
  /** Activate the exact binding after the run record is durable. */
  admit(root: SessionId, bindingEpoch: number): Promise<void>
  /** Register only source tools scoped to this exact admitted agent. */
  install(agent: Agent, assignment: DiagnosticAssignment, root: SessionId): () => void
  /** Cancel caller work and await observed settlement; uncertainty must reject. */
  cancel(root: SessionId): Promise<void>
  /** True only after caller work and uncommitted results have settled. */
  quiescent(root: SessionId): boolean
  /** True only for a closeout with a committed successful native result receipt. */
  closed?(root: SessionId, producer: SessionId, assignmentId: string): boolean
  /** Outstanding caller operations for this root or one producer. */
  activity?(root: SessionId, producer?: SessionId): { activeCalls: number; pendingResults: number }
}

interface RunData {
  runId: string
  rootSessionId: string
  state: 'admitted' | 'running' | 'cancelling' | 'incomplete' | 'completed' | 'failed'
  executorBindingId: string
  bindingEpoch: number
  admissionDigest: string
  admission: DiagnosticAdmission
  activeChildren: number
  activeModelRequests: number
  activeCalls: number
  pendingResults: number
  quiescent: boolean
}
interface AssignmentData {
  runId: string
  rootSessionId: string
  parentSessionId: string
  assignmentId: string
  assignmentDigest: string
  state: 'prepared' | 'reserved' | 'accepted' | 'uncertain'
  idempotencyKey: string
  assignment: DiagnosticAssignment
  childSessionId?: string
  messageId?: string
}
interface RequestData {
  id: string
  producerSessionId: string
  assignmentId: string
  outputTokens: number
  state: 'reserved' | 'settled'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable admission and current executor epoch; required on replay. */
    'diagnostic/run-state': RunData
    /** Full caller assignment and durable native-child reservation. */
    'diagnostic/reservation': AssignmentData
    /** Public assignment lifecycle without private delivery metadata. */
    'diagnostic/assignment-state': Omit<AssignmentData, 'state' | 'messageId'> & {
      state: 'prepared' | 'dispatched' | 'running' | 'uncertain'
    }
    /** Native child state derived from central requests, turns and caller receipts. */
    'diagnostic/child-state': JsonValue
    /** Read provenance computed after the native tool result has durably committed. */
    'diagnostic/evidence-read': JsonValue
    /** Child-local admission identity; never grants authority without the root reservation. */
    'diagnostic/member': { rootSessionId: string; runId: string; assignmentId: string }
    /** Conservative output-ceiling charge for every model request, including retries and compaction. */
    'diagnostic/request': RequestData
    /** Bridge-owned durable receipts in the central log; credentials must never be included. */
    'diagnostic/executor': { kind: string; value: JsonValue }
  }
}

/** Exact model selection, preserving omitted role settings. */
function selection(assignment: DiagnosticAssignment): ModelSelection {
  return {
    ...assignment.commonModel,
    outputLimit: assignment.roleSettings.outputLimit,
    ...(assignment.roleSettings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(assignment.roleSettings.reasoningEffort) }),
    ...(assignment.roleSettings.mode === undefined ? {} : { mode: assignment.roleSettings.mode }),
  }
}

/** Core owner for diagnostic admission, prepared work and native children. */
export class DiagnosticRuns {
  private executor: DiagnosticExecutor | undefined
  private readonly tails = new Map<SessionId, Promise<unknown>>()
  private readonly installations = new Map<SessionId, () => void>()
  private readonly configuring = new Set<SessionId>()
  private readonly deliveries = new Set<SessionId>()

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentRuntime,
  ) {}

  /**
   * Join the installed bridge to core; disposal withdraws admission and future activation.
   * @param executor - authoritative caller transport.
   * @returns scoped provider disposer.
   */
  registerExecutor(executor: DiagnosticExecutor): () => void {
    if (this.executor !== undefined) throw new Error('Diagnostic executor already registered')
    const agents = this.ctx.get('agents')
    if (
      agents === undefined ||
      this.ctx.get('sessions') === undefined ||
      this.ctx.get('sessionPersistence') === undefined
    )
      throw new Error('Diagnostic sessions require agents and durable persistence')
    this.executor = executor
    const disposePolicy = agents.registerPolicy({
      id: DIAGNOSTIC_POLICY,
      instructions: false,
      models: false,
      workspace: false,
      presets: false,
      fork: true,
      attestation: { diagnosticChildrenVersion: 1, executorProtocolVersion: 2, trustedLanHistory: true },
      apply: agent => this.install(agent),
    })
    const disposeSetup = this.subagents.registerContinuableSetup((childCtx) => {
      const child = childCtx.agent as Agent
      if (child.session.header.sessionPolicy !== DIAGNOSTIC_POLICY) return () => {}
      const parentId = child.session.header.parentSession
      if (parentId === undefined) throw new DiagnosticError('diagnostic-parent-stale', 'Missing diagnostic parent')
      const root = this.root(parentId)
      const reservation = this.assignments(root.session).findLast(value => value.childSessionId === child.id)
      if (reservation === undefined)
        throw new DiagnosticError('diagnostic-assignment-conflict', 'No durable child reservation')
      if (!child.session.events.some(event => event.type === 'diagnostic/member'))
        child.session.configureInstructions(diagnosticInstructions(reservation.assignment))
      const member = child.session.events.findLast(event => event.type === 'diagnostic/member')
      if (member?.type !== 'diagnostic/member' || member.data.assignmentId !== reservation.assignmentId) {
        child.session.append('diagnostic/member', {
          rootSessionId: root.id,
          runId: reservation.runId,
          assignmentId: reservation.assignmentId,
        })
      }
      return () => {}
    })
    const disposeStream = this.ctx.on('llm/stream', (options, next) => this.stream(options, next))
    const disposeEvents = this.ctx.on('session/event', (session, event) => {
      if (session.header.sessionPolicy !== DIAGNOSTIC_POLICY || event.type !== 'turn/end') return
      const rootId = session.header.origin === 'subagent' ? session.header.parentSession : session.id
      // A disposed root or failed store remains represented by its last durable non-quiescent state.
      if (rootId !== undefined)
        queueMicrotask(() => {
          void this.refresh(rootId).catch(() => {})
        })
      if (event.data.reason.kind !== 'aborted') return
      // Caller disconnection can prevent confirmed settlement; the stopping record remains authoritative.
      if (session.header.origin !== 'subagent') void this.cancel(session.id).catch(() => {})
    })
    return () => {
      this.executor = undefined
      disposePolicy()
      disposeSetup()
      disposeStream()
      disposeEvents()
      // Resident sessions retain their deny rules after bridge removal. Their scopes own cleanup.
    }
  }

  /**
   * Joint capability exists only with a registered bridge and in-process child provider.
   * @returns supported version and limits, or undefined when unavailable.
   */
  capability():
    | {
      id: string
      capabilityVersion: 1
      executorProtocolVersion: 2
      profiles: string[]
      maxChildren: number
      maxConcurrentChildren: number
    }
    | undefined {
    const provider = this.subagents.getProvider('spawn')
    if (
      this.executor === undefined ||
      provider?.prepareContinuable === undefined ||
      provider.inheritsParentContext !== false
    )
      return undefined
    return {
      id: DIAGNOSTIC_POLICY,
      capabilityVersion: 1,
      executorProtocolVersion: 2,
      profiles: ['source-review-mode-a/v1'],
      maxChildren: 8,
      maxConcurrentChildren: 3,
    }
  }

  private root(id: SessionId): Agent {
    const agent = this.ctx.get('agents')?.get(id)
    if (
      agent === undefined ||
      agent.session.header.sessionPolicy !== DIAGNOSTIC_POLICY ||
      agent.session.header.origin === 'subagent'
    )
      throw new DiagnosticError('diagnostic-parent-stale', 'Diagnostic root is unavailable')
    return agent
  }

  private run(session: Session): RunData | undefined {
    const event = session.events.findLast(event => event.type === 'diagnostic/run-state')
    return event?.type === 'diagnostic/run-state' ? event.data : undefined
  }

  private assignments(session: Session): AssignmentData[] {
    const values = new Map<string, AssignmentData>()
    for (const event of session.events)
      if (event.type === 'diagnostic/reservation') values.set(event.data.assignmentId, event.data)
    return [...values.values()]
  }

  /** Serialize read/check/append/flush without introducing another store. */
  private async transact<T>(id: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(id) ?? Promise.resolve()
    const running = previous.then(operation, operation)
    const tail = running.catch(() => {})
    this.tails.set(id, tail)
    try {
      return await running
    } finally {
      if (this.tails.get(id) === tail) this.tails.delete(id)
    }
  }

  private service<K extends 'agents' | 'sessions' | 'sessionPersistence'>(name: K): Context[K] {
    const service = this.ctx.get(name)
    if (service === undefined) throw new DiagnosticError('diagnostic-capability-unavailable', `Diagnostic service ${name} is unavailable`)
    return service
  }

  private requireExecutor(): DiagnosticExecutor {
    if (this.executor === undefined)
      throw new DiagnosticError('diagnostic-capability-unavailable', 'Diagnostic executor is unavailable')
    return this.executor
  }

  private async flush(session: Session): Promise<void> {
    await this.service('sessions').flush(session)
  }

  /**
   * Validate assignment closeout without granting root completion to a child.
   * @param agent - exact producing agent.
   * @param report - caller-bound result object.
   * @returns after schema and root-tree settlement checks pass.
   */
  async validateCloseout(agent: Agent, report: unknown): Promise<void> {
    const member = this.membership(agent)
    if (member === undefined)
      throw new DiagnosticError('diagnostic-policy-rejected', 'No admitted diagnostic assignment')
    this.requireRun(member.root)
    diagnosticCanonicalJson(report)
    diagnosticResultSchema(member.assignment.resultSchema.schema).parse(report)
    if (agent !== member.root) return
    const children = await this.subagents.listChildren(agent.id, new AbortController().signal)
    if (
      this.assignments(agent.session).some(
        record =>
          record.childSessionId === undefined ||
          !this.executor?.closed?.(agent.id, SessionId(record.childSessionId), record.assignmentId),
      ) ||
      children.some(child => child.kind === 'diagnostic') ||
      this.assignments(agent.session).some(record => record.state !== 'accepted') ||
      this.service('agents')
        .list()
        .some(child => child.session.header.parentSession === agent.id && child.status !== 'idle') ||
      !this.executor?.quiescent(agent.id)
    )
      throw new DiagnosticError(
        'diagnostic-child-unsettled',
        'Root closeout requires settled children and caller reads',
        true,
      )
  }

  /**
   * Reconcile an authenticated executor epoch without replaying uncertain model work.
   * @param rootId - original root identity.
   * @param epoch - newly committed binding epoch.
   * @returns whether central history proves that no prior model request remains uncertain.
   */
  async rebind(rootId: SessionId, epoch: number): Promise<boolean> {
    const root = this.root(rootId)
    return this.transact(rootId, async () => {
      const run = this.run(root.session)
      if (run === undefined) return true
      const binding = this.executor?.binding(rootId)
      if (
        binding?.executorBindingId !== run.executorBindingId ||
        binding.runId !== run.runId ||
        binding.bindingEpoch !== epoch ||
        epoch < run.bindingEpoch ||
        epoch > run.bindingEpoch + 1
      )
        throw new DiagnosticError('diagnostic-binding-stale', 'Rebind identity does not match')
      const requests = new Map<string, RequestData>()
      for (const event of root.session.events)
        if (event.type === 'diagnostic/request') requests.set(event.data.id, event.data)
      const settled =
        [...requests.values()].every(request => request.state === 'settled') &&
        this.assignments(root.session).every(
          assignment => assignment.state === 'prepared' || assignment.state === 'accepted',
        )
      root.session.append('diagnostic/run-state', {
        ...run,
        bindingEpoch: epoch,
        state: settled ? run.state : 'incomplete',
        quiescent: false,
      })
      await this.flush(root.session)
      return settled && run.state !== 'cancelling' && run.state !== 'incomplete'
    })
  }

  /**
   * Admit one idle policy-bound root against its inert caller binding.
   * @param input - versioned admission payload.
   * @returns stable admission identity after durable commit; exact retries are idempotent.
   */
  async admit(
    input: unknown,
  ): Promise<{
    runId: string
    rootSessionId: string
    state: 'admitted'
    admissionDigest: string
    bindingEpoch: number
    duplicate: boolean
  }> {
    const admission = diagnosticAdmissionSchema.parse(input)
    const root = this.root(SessionId(admission.rootSessionId))
    return this.transact(root.id, async () => {
      const admissionDigest = diagnosticRecordDigest(admission)
      const prior = this.run(root.session)
      if (prior !== undefined) {
        if (prior.admissionDigest !== admissionDigest)
          throw new DiagnosticError('diagnostic-assignment-conflict', 'Run admission conflicts with durable history')
        await this.flush(root.session)
        const binding = this.executor?.binding(root.id)
        if (binding?.bindingEpoch !== prior.bindingEpoch || binding.executorBindingId !== prior.executorBindingId)
          throw new DiagnosticError('diagnostic-binding-stale', 'Admission requires binding reconciliation')
        if (binding.state === 'awaiting-admission') await this.requireExecutor().admit(root.id, binding.bindingEpoch)
        this.install(root)
        return {
          runId: prior.runId,
          rootSessionId: root.id,
          state: 'admitted',
          admissionDigest,
          bindingEpoch: prior.bindingEpoch,
          duplicate: true,
        }
      }
      parseDiagnosticAdmission(admission, Date.now())
      if (this.capability() === undefined)
        throw new DiagnosticError('diagnostic-capability-unavailable', 'Diagnostic child capability is unavailable')
      if (root.status !== 'idle' || root.session.events.some(event => event.type === 'turn/start'))
        throw new DiagnosticError('diagnostic-policy-rejected', 'Admission requires a fresh idle root')
      const binding = this.requireExecutor().binding(root.id)
      if (
        binding.state !== 'awaiting-admission' ||
        binding.rootSessionId !== root.id ||
        binding.runId !== admission.runId ||
        binding.executorBindingId !== admission.executorBindingId ||
        binding.bindingEpoch !== admission.bindingEpoch ||
        binding.comparisonDigest !== admission.comparisonDigest ||
        !isDeepStrictEqual(binding.sourceRefs, admission.sourceRefs)
      )
        throw new DiagnosticError('diagnostic-binding-stale', 'Executor binding does not match admission')
      this.configuring.add(root.id)
      try {
        root.session.configureInstructions(diagnosticInstructions(admission.coordinatorAssignment))
      } finally {
        this.configuring.delete(root.id)
      }
      root.session.append('diagnostic/run-state', {
        runId: admission.runId,
        rootSessionId: root.id,
        state: 'admitted',
        admission,
        admissionDigest,
        executorBindingId: binding.executorBindingId,
        bindingEpoch: binding.bindingEpoch,
        activeChildren: 0,
        activeModelRequests: 0,
        activeCalls: 0,
        pendingResults: 0,
        quiescent: false,
      })
      await this.flush(root.session)
      await this.requireExecutor().admit(root.id, binding.bindingEpoch)
      this.install(root)
      return {
        runId: admission.runId,
        rootSessionId: root.id,
        state: 'admitted',
        admissionDigest,
        bindingEpoch: binding.bindingEpoch,
        duplicate: false,
      }
    })
  }

  /**
   * Persist a fully resolved child assignment; changed idempotency reuse rejects.
   * @param input - root/run identity, idempotency key and assignment.
   * @returns immutable prepared identity after flush.
   */
  async prepare(input: {
    runId: string
    rootSessionId: string
    idempotencyKey: string
    assignment: unknown
  }): Promise<{
    runId: string
    assignmentId: string
    assignmentDigest: string
    state: 'prepared'
    duplicate: boolean
  }> {
    const assignment = parseDiagnosticAssignment(input.assignment)
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey))
      throw new DiagnosticError('diagnostic-policy-rejected', 'Invalid assignment idempotency key')
    const root = this.root(SessionId(input.rootSessionId))
    return this.transact(root.id, async () => {
      const run = this.requireRun(root)
      if (
        input.runId !== run.runId ||
        assignment.runId !== run.runId ||
        assignment.parentSessionId !== root.id ||
        assignment.role === 'coordinator'
      )
        throw new DiagnosticError('diagnostic-parent-stale', 'Assignment does not belong to this root')
      const prior = this.assignments(root.session).find(
        value => value.assignmentId === assignment.assignmentId || value.idempotencyKey === input.idempotencyKey,
      )
      if (prior !== undefined) {
        if (
          prior.assignmentDigest !== assignment.digest ||
          prior.idempotencyKey !== input.idempotencyKey ||
          prior.assignmentId !== assignment.assignmentId
        )
          throw new DiagnosticError('diagnostic-assignment-conflict', 'Assignment identity was already used')
        return {
          runId: run.runId,
          assignmentId: assignment.assignmentId,
          assignmentDigest: assignment.digest,
          state: 'prepared',
          duplicate: true,
        }
      }
      const coordinator = run.admission.coordinatorAssignment
      if (
        !isDeepStrictEqual(assignment.commonModel, coordinator.commonModel) ||
        assignment.sourceRefs.some(
          source => !run.admission.sourceRefs.some(admitted => isDeepStrictEqual(source, admitted)),
        ) ||
        assignment.authority.tools.some(tool => !coordinator.authority.tools.includes(tool)) ||
        assignment.authority.readRoots.some(id => !coordinator.authority.readRoots.includes(id))
      )
        throw new DiagnosticError('diagnostic-policy-rejected', 'Child policy widens the admitted run')
      if (
        assignment.budget.maxModelRequests >
          run.admission.maxModelRequests - run.admission.rootSynthesisReserveRequests ||
        assignment.budget.maxOutputTokens > run.admission.maxOutputTokens - run.admission.rootSynthesisReserveTokens ||
        Date.parse(assignment.budget.deadline) > Date.parse(run.admission.deadline) ||
        Date.parse(assignment.budget.deadline) <= Date.now()
      )
        throw new DiagnosticError('diagnostic-budget-exhausted', 'Assignment budget exceeds available child work')
      this.reserve(root.session, {
        runId: run.runId,
        rootSessionId: root.id,
        parentSessionId: root.id,
        assignmentId: assignment.assignmentId,
        assignmentDigest: assignment.digest,
        idempotencyKey: input.idempotencyKey,
        assignment,
        state: 'prepared',
      })
      await this.flush(root.session)
      return {
        runId: run.runId,
        assignmentId: assignment.assignmentId,
        assignmentDigest: assignment.digest,
        state: 'prepared',
        duplicate: false,
      }
    })
  }

  private reserve(session: Session, record: AssignmentData): void {
    session.append('diagnostic/reservation', record)
    const { messageId: _messageId, state, ...value } = record
    session.append('diagnostic/assignment-state', {
      ...value,
      state: state === 'reserved' ? 'dispatched' : state === 'accepted' ? 'running' : state,
    })
  }

  /**
   * Publish observed tree activity after a native turn or caller receipt settles.
   * @param rootId - root owning the central diagnostic journal.
   * @returns after current counters and child states are durable.
   */
  async refresh(rootId: SessionId): Promise<void> {
    const root = this.root(rootId)
    const snapshots = new Map(
      await Promise.all(
        this.assignments(root.session)
          .filter(record => record.childSessionId !== undefined && record.state === 'accepted')
          .map(async (record) => {
            if (record.childSessionId === undefined)
              throw new DiagnosticError('diagnostic-parent-stale', 'Child identity is missing')
            const id = SessionId(record.childSessionId)
            const live = this.service('agents').get(id)
            return [id, live?.session.events ?? (await this.service('sessionPersistence').load(id)).events] as const
          }),
      ),
    )
    const run = this.run(root.session)
    if (!run) return
    const requests = new Map<string, RequestData>()
    for (const event of root.session.events)
      if (event.type === 'diagnostic/request') requests.set(event.data.id, event.data)
    const activeRequests = [...requests.values()].filter(request => request.state === 'reserved')
    const activity = this.executor?.activity?.(rootId) ?? { activeCalls: 0, pendingResults: 0 }
    const children = new Map<string, AssignmentData>()
    for (const assignment of this.assignments(root.session))
      if (assignment.childSessionId) children.set(assignment.childSessionId, assignment)
    let activeChildren = 0
    let uncertain = false
    for (const [childId, record] of children) {
      const child = this.service('agents').get(SessionId(childId))
      const activeModelRequests = activeRequests.filter(request => request.producerSessionId === childId).length
      const caller = this.executor?.activity?.(rootId, SessionId(childId)) ?? { activeCalls: 0, pendingResults: 0 }
      const events = child?.session.events ?? snapshots.get(SessionId(childId))
      const terminal = events?.findLast(event => event.type === 'turn/end')
      const start = events?.findLast(event => event.type === 'turn/start')
      const idle = child ? child.status === 'idle' : terminal !== undefined && terminal.seq > (start?.seq ?? -1)
      const quiescent =
        idle &&
        activeModelRequests === 0 &&
        caller.activeCalls === 0 &&
        caller.pendingResults === 0 &&
        record.state === 'accepted'
      const completed = quiescent && terminal?.type === 'turn/end' && terminal.data.reason.kind === 'completed'
      const state =
        record.state === 'uncertain' || events === undefined
          ? 'uncertain'
          : completed
            ? 'settled'
            : quiescent
              ? 'failed'
              : record.state === 'reserved'
                ? 'starting'
                : 'running'
      if (!quiescent) activeChildren++
      uncertain ||= state === 'uncertain'
      root.session.append('diagnostic/child-state', {
        runId: run.runId,
        rootSessionId: root.id,
        parentSessionId: root.id,
        childSessionId: childId,
        assignmentId: record.assignmentId,
        assignmentDigest: record.assignmentDigest,
        state,
        modelDigest: diagnosticRecordDigest({ ...record.assignment.commonModel, ...record.assignment.roleSettings }),
        instructionDigest: record.assignment.instructionSnapshot.digest,
        toolCeilingDigest: diagnosticRecordDigest(record.assignment.authority),
        activeModelRequests,
        ...caller,
        quiescent,
        ...(quiescent ? { stopReason: completed ? 'completed' : 'failed' } : {}),
      })
    }
    const quiescent =
      root.status === 'idle' &&
      activeChildren === 0 &&
      activeRequests.length === 0 &&
      activity.activeCalls === 0 &&
      activity.pendingResults === 0 &&
      !uncertain &&
      this.executor?.quiescent(rootId) === true
    const rootClosed =
      this.executor?.closed?.(rootId, rootId, run.admission.coordinatorAssignment.assignmentId) === true
    const state =
      quiescent && rootClosed && (run.state === 'running' || run.state === 'admitted')
        ? 'completed'
        : run.state === 'admitted' && root.status !== 'idle'
          ? 'running'
          : quiescent && run.state === 'cancelling'
            ? 'incomplete'
            : run.state
    root.session.append('diagnostic/run-state', {
      ...run,
      state,
      activeChildren,
      activeModelRequests: activeRequests.length,
      ...activity,
      quiescent,
    })
    await this.flush(root.session)
  }

  private requireRun(root: Agent): RunData {
    const run = this.run(root.session)
    if (
      run === undefined ||
      run.rootSessionId !== root.id ||
      run.state === 'cancelling' ||
      run.state === 'incomplete' ||
      run.state === 'completed' ||
      run.state === 'failed'
    )
      throw new DiagnosticError('diagnostic-policy-rejected', 'No active diagnostic run')
    const binding = this.executor?.binding(root.id)
    if (
      binding === undefined ||
      binding.state !== 'active' ||
      binding.bindingEpoch !== run.bindingEpoch ||
      binding.executorBindingId !== run.executorBindingId
    )
      throw new DiagnosticError('diagnostic-binding-stale', 'Diagnostic executor requires reconciliation')
    return run
  }

  private membership(agent: Agent): { root: Agent; assignment: DiagnosticAssignment } | undefined {
    if (agent.session.header.sessionPolicy !== DIAGNOSTIC_POLICY) return undefined
    if (agent.session.header.origin !== 'subagent') {
      const run = this.run(agent.session)
      if (run === undefined) return undefined
      if (run.rootSessionId !== agent.id)
        throw new DiagnosticError('diagnostic-parent-stale', 'Run cannot be forked into another root')
      return { root: agent, assignment: run.admission.coordinatorAssignment }
    }
    const member = agent.session.events.findLast(event => event.type === 'diagnostic/member')
    if (member?.type !== 'diagnostic/member')
      throw new DiagnosticError('diagnostic-parent-stale', 'Missing child admission')
    const root = this.root(SessionId(member.data.rootSessionId))
    const reservation = this.assignments(root.session).find(
      value => value.assignmentId === member.data.assignmentId && value.childSessionId === agent.id,
    )
    if (
      reservation === undefined ||
      member.data.runId !== reservation.runId ||
      agent.session.header.parentSession !== root.id
    )
      throw new DiagnosticError('diagnostic-parent-stale', 'Child reservation does not match')
    return { root, assignment: reservation.assignment }
  }

  private install(agent: Agent): void {
    this.installations.get(agent.id)?.()
    const member = this.membership(agent)
    const disposers: (() => void)[] = []
    disposers.push(agent.ctx.tools.restrict({ allow: [] }))
    disposers.push(
      agent.session.guardEvents((event) => {
        if (this.configuring.has(agent.id)) return
        // The full host initializes permission/model defaults after policy installation.
        // Admission replaces those defaults and then freezes the effective assignment.
        if (member !== undefined
          && ['session/instructions', 'model/selection', 'sandbox/mode', 'approval/policy'].includes(event.type))
          throw new DiagnosticError('diagnostic-policy-rejected', 'Diagnostic policy is immutable')
        if (event.type === 'turn/start') {
          if (member === undefined)
            throw new DiagnosticError('diagnostic-policy-rejected', 'Diagnostic run admission is required')
          this.requireRun(member.root)
        }
      }),
    )
    if (member !== undefined) {
      const admitted = this.run(member.root.session)
      if (admitted === undefined) throw new DiagnosticError('diagnostic-policy-rejected', 'Diagnostic admission is missing')
      const limits = admitted.admission
      const deadline = Math.min(
        Date.parse(member.assignment.budget.deadline),
        Date.parse(limits.deadline) - (agent === member.root ? 0 : limits.rootSynthesisReserveMs),
      )
      const timer = setTimeout(
        () => {
          agent.cancel({ kind: 'user' })
          // Cancellation may require caller reconciliation; persisted reservations retain uncertainty.
          void this.executor?.cancel(member.root.id).catch(() => {})
        },
        Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)),
      )
      timer.unref()
      disposers.push(() => clearTimeout(timer))
      const selected = selection(member.assignment)
      disposers.push(installModelSelection(agent.ctx, { current: selected, assembled: undefined }))
      disposers.push(this.requireExecutor().install(agent, member.assignment, member.root.id))
      if (agent === member.root) {
        for (const name of ['subagent', 'send_message'] as const) {
          if (!member.assignment.authority.tools.includes(name)) continue
          const properties =
            name === 'subagent'
              ? { run_in_background: { type: 'boolean', const: true }, assignmentId: { type: 'string' } }
              : { childSessionId: { type: 'string' }, assignmentId: { type: 'string' } }
          const tool: ToolDefinition = {
            name,
            description: 'Run a caller-prepared diagnostic assignment.',
            parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
            output: {
              schema: { type: 'object' },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
            execute: (args: unknown, execution: ToolExecution) =>
              this.deliver(member.root, args, execution.signal, name === 'send_message'),
          }
          disposers.push(agent.ctx.tools.register(tool))
        }
      }
    }
    const dispose = () => {
      for (const undo of disposers.reverse()) undo()
    }
    this.installations.set(agent.id, dispose)
    agent.ctx.effect(() => () => {
      if (this.installations.get(agent.id) === dispose) {
        dispose()
        this.installations.delete(agent.id)
      }
    })
  }

  private async deliver(
    root: Agent,
    input: unknown,
    signal: AbortSignal,
    continuation: boolean,
  ): Promise<Record<string, JsonValue>> {
    if (input === null || typeof input !== 'object' || Array.isArray(input))
      throw new DiagnosticError('diagnostic-policy-rejected', 'Expected prepared assignment arguments')
    const args = input as Record<string, unknown>
    const expected = continuation ? ['assignmentId', 'childSessionId'] : ['assignmentId', 'run_in_background']
    if (
      Object.keys(args).length !== 2 ||
      Object.keys(args).some(key => !expected.includes(key)) ||
      typeof args.assignmentId !== 'string' ||
      (continuation ? typeof args.childSessionId !== 'string' : args.run_in_background !== true)
    )
      throw new DiagnosticError('diagnostic-policy-rejected', 'Only prepared assignment references are allowed')
    return this.transact(root.id, async () => {
      signal.throwIfAborted()
      const run = this.requireRun(root)
      let record = this.assignments(root.session).find(value => value.assignmentId === args.assignmentId)
      if (record === undefined)
        throw new DiagnosticError('diagnostic-assignment-conflict', 'Assignment is not prepared')
      if (record.state === 'accepted') {
        if (continuation && record.childSessionId !== args.childSessionId)
          throw new DiagnosticError('diagnostic-assignment-conflict', 'Assignment belongs to another child')
        return this.deliveryValue(record, true, continuation)
      }
      if (record.state !== 'prepared')
        throw new DiagnosticError(
          'diagnostic-child-unsettled',
          'Prior child delivery requires history reconciliation',
          true,
        )
      const charged = root.session.events.filter(
        event => event.type === 'diagnostic/request' && event.data.state === 'reserved',
      )
      if (
        charged.length >= run.admission.maxModelRequests - run.admission.rootSynthesisReserveRequests ||
        charged.reduce((sum, event) => sum + (event.type === 'diagnostic/request' ? event.data.outputTokens : 0), 0) +
          record.assignment.roleSettings.outputLimit >
          run.admission.maxOutputTokens - run.admission.rootSynthesisReserveTokens ||
        Date.now() >=
          Math.min(
            Date.parse(record.assignment.budget.deadline),
            Date.parse(run.admission.deadline) - run.admission.rootSynthesisReserveMs,
          )
      )
        throw new DiagnosticError(
          'diagnostic-budget-exhausted',
          'No child request allowance remains after root reserves',
        )
      const children = await this.subagents.listChildren(root.id, signal)
      if (children.some(child => child.kind === 'diagnostic'))
        throw new DiagnosticError('diagnostic-child-unsettled', 'Child catalogue cannot be verified', true)
      const active = this.service('agents')
        .list()
        .filter(agent => agent.session.header.parentSession === root.id && agent.status !== 'idle')
      if (active.length >= run.admission.maxConcurrentChildren)
        throw new DiagnosticError('diagnostic-budget-exhausted', 'Diagnostic child concurrency is exhausted')
      const childId = continuation ? SessionId(args.childSessionId as string) : SessionId(randomUUID())
      if (continuation) {
        const previous = this.assignments(root.session).find(
          value => value.childSessionId === childId && value.state === 'accepted',
        )
        if (
          previous === undefined ||
          !isDeepStrictEqual(previous.assignment.commonModel, record.assignment.commonModel) ||
          !isDeepStrictEqual(previous.assignment.roleSettings, record.assignment.roleSettings) ||
          !isDeepStrictEqual(previous.assignment.instructionSnapshot, record.assignment.instructionSnapshot) ||
          !isDeepStrictEqual(previous.assignment.authority, record.assignment.authority) ||
          previous.assignment.role !== record.assignment.role
        )
          throw new DiagnosticError('diagnostic-policy-rejected', 'Continuation changes frozen child policy')
      } else if (children.length >= run.admission.maxChildren)
        throw new DiagnosticError('diagnostic-budget-exhausted', 'Diagnostic child limit is exhausted')
      record = { ...record, state: 'reserved', childSessionId: childId }
      this.reserve(root.session, record)
      await this.flush(root.session)
      this.deliveries.add(childId)
      try {
        const prompt = [{ type: 'text' as const, text: diagnosticCanonicalJson(record.assignment) }]
        let messageId: MessageId
        if (continuation) {
          const child = this.service('agents').get(childId)
          if (child !== undefined) {
            if (child.status !== 'idle')
              throw new DiagnosticError('diagnostic-child-unsettled', 'Continuation requires an idle child')
            child.session.append('diagnostic/member', {
              rootSessionId: root.id,
              runId: run.runId,
              assignmentId: record.assignmentId,
            })
            await this.flush(child.session)
            this.install(child)
          }
          messageId = await this.subagents.followup(root, childId, prompt, { source: { kind: 'user' }, signal })
        } else {
          const started = await this.subagents.startContinuable({
            provider: 'spawn',
            label: record.assignment.role,
            childId,
            sessionPolicy: DIAGNOSTIC_POLICY,
            request: {
              parent: root,
              prompt,
              maxDepth: 1,
              agentOptions: {
                provider: record.assignment.commonModel.provider,
                model: record.assignment.commonModel.model,
                maxTokens: record.assignment.roleSettings.outputLimit,
              },
            },
            signal,
          })
          messageId = started.messageId
        }
        record = { ...record, state: 'accepted', messageId }
        this.reserve(root.session, record)
        await this.flush(root.session)
        return this.deliveryValue(record, false, continuation)
      } catch (error) {
        this.reserve(root.session, { ...record, state: 'uncertain' })
        await this.flush(root.session)
        throw error
      } finally {
        this.deliveries.delete(childId)
      }
    })
  }

  /**
   * Reject raw native start/continuation calls for policy-bound sessions.
   * @param parent - exact parent authorizing delegation.
   * @param childId - privately reserved child identity, absent for one-shot calls.
   */
  assertDelivery(parent: Agent, childId?: SessionId): void {
    if (
      parent.session.header.sessionPolicy === DIAGNOSTIC_POLICY &&
      (childId === undefined || !this.deliveries.has(childId) || parent.session.header.origin === 'subagent')
    ) {
      throw new DiagnosticError('diagnostic-policy-rejected', 'Diagnostic children require a prepared assignment')
    }
  }

  private deliveryValue(record: AssignmentData, duplicate: boolean, continuation: boolean): Record<string, JsonValue> {
    if (record.childSessionId === undefined)
      throw new DiagnosticError('diagnostic-parent-stale', 'Child identity is missing')
    return {
      accepted: true,
      runId: record.runId,
      parentSessionId: record.parentSessionId,
      childSessionId: record.childSessionId,
      assignmentId: record.assignmentId,
      state: 'accepted',
      duplicate,
      ...(!continuation || record.messageId === undefined ? {} : { messageId: record.messageId }),
    }
  }

  private async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const agent = options.sessionId === undefined ? undefined : this.service('agents').get(options.sessionId)
    if (agent?.session.header.sessionPolicy !== DIAGNOSTIC_POLICY) {
      yield* next()
      return
    }
    const member = this.membership(agent)
    if (member === undefined)
      throw new DiagnosticError('diagnostic-policy-rejected', 'Diagnostic admission is required')
    const request = await this.transact(member.root.id, async () => {
      const run = this.requireRun(member.root)
      const expected = selection(member.assignment)
      if (options.purpose === undefined) {
        const snapshot = member.assignment.instructionSnapshot
        const system = [snapshot.baseContent, ...snapshot.expertise.map(asset => asset.content)]
          .filter(Boolean)
          .join('\n\n')
        if (
          options.system !== system ||
          options.tools?.some(
            tool =>
              !member.assignment.authority.tools.includes(
                tool.name as DiagnosticAssignment['authority']['tools'][number],
              ),
          )
        )
          throw new DiagnosticError(
            'diagnostic-policy-rejected',
            'Effective instructions or tools exceed the assignment',
          )
      }
      const maxTokens = options.maxTokens
      if (
        options.provider !== expected.provider ||
        options.model !== expected.model ||
        options.contextWindow !== expected.contextWindow ||
        options.reasoningEffort !== expected.reasoningEffort ||
        (options.mode ?? 'default') !== (expected.mode ?? 'default') ||
        options.options !== undefined ||
        typeof maxTokens !== 'number' ||
        !Number.isSafeInteger(maxTokens) ||
        maxTokens <= 0 ||
        maxTokens > member.assignment.roleSettings.outputLimit
      )
        throw new DiagnosticError('diagnostic-policy-rejected', 'Effective model request widens the assignment')
      const charges = member.root.session.events
        .filter(event => event.type === 'diagnostic/request')
        .filter(event => event.data.state === 'reserved')
      const own = charges.filter(event => event.data.assignmentId === member.assignment.assignmentId)
      const child = agent !== member.root
      const now = Date.now()
      if (
        now >= Date.parse(member.assignment.budget.deadline) ||
        now >= Date.parse(run.admission.deadline) - (child ? run.admission.rootSynthesisReserveMs : 0) ||
        charges.length >= run.admission.maxModelRequests - (child ? run.admission.rootSynthesisReserveRequests : 0) ||
        charges.reduce((sum, event) => sum + event.data.outputTokens, 0) + maxTokens >
          run.admission.maxOutputTokens - (child ? run.admission.rootSynthesisReserveTokens : 0) ||
        own.length >= member.assignment.budget.maxModelRequests ||
        own.reduce((sum, event) => sum + event.data.outputTokens, 0) + maxTokens >
          member.assignment.budget.maxOutputTokens
      )
        throw new DiagnosticError('diagnostic-budget-exhausted', 'Diagnostic request budget is exhausted')
      const record: RequestData = {
        id: randomUUID(),
        producerSessionId: agent.id,
        assignmentId: member.assignment.assignmentId,
        outputTokens: maxTokens,
        state: 'reserved',
      }
      member.root.session.append('diagnostic/request', record)
      await this.refresh(member.root.id)
      return record
    })
    try {
      yield* next()
    } finally {
      member.root.session.append('diagnostic/request', { ...request, state: 'settled' })
      await this.refresh(member.root.id)
    }
  }

  /**
   * Stop an admitted tree and retain incomplete state; an ACK never establishes quiescence.
   * @param rootId - admitted root identity.
   * @returns after native descendants and caller work have settled.
   */
  async cancel(rootId: SessionId): Promise<void> {
    const root = this.root(rootId)
    const run = this.run(root.session)
    if (
      run === undefined ||
      run.state === 'cancelling' ||
      run.state === 'incomplete' ||
      run.state === 'completed' ||
      run.state === 'failed'
    )
      return
    root.session.append('diagnostic/run-state', { ...run, state: 'cancelling', quiescent: false })
    await this.flush(root.session)
    root.cancel({ kind: 'user' })
    await Promise.all([this.subagents.drainContinuableDescendants([root]), this.executor?.cancel(root.id)])
    await root.whenIdle()
    root.session.append('diagnostic/run-state', {
      ...run,
      state: 'incomplete',
      quiescent: this.executor?.quiescent(root.id) === true,
    })
    await this.flush(root.session)
  }
}
