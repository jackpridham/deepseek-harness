/** Diagnostic run admission and native child ownership over the central session log. */
import type {} from '@deepseek-ai/dsh-compaction'
import { z } from 'zod'
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
  diagnosticAdmissionSchema, diagnosticDispatchSchema, diagnosticPreparationSchema,
  diagnosticWaitSchema, diagnosticReadReportSchema, diagnosticPublishSchema,
} from './diagnostic-contract.ts'
import type { DiagnosticAdmission, DiagnosticAssignment, DiagnosticPublication, DiagnosticPublicationResult, DiagnosticWorkerRequest } from './diagnostic-contract.ts'

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

/** Workflow failures use the public tool/RPC code and retry vocabulary. */
export class DiagnosticWorkflowError extends Error {
  constructor(readonly code: 'invalid_request' | 'request_conflict' | 'capacity_unavailable' | 'run_limit_reached' | 'assignment_rejected' | 'report_unavailable' | 'report_conflict' | 'authority_denied' | 'reconciliation_required', message: string, readonly retry: 'never' | 'after_worker_result' | 'after_reconciliation' = 'never') { super(message); this.name = 'DiagnosticWorkflowError' }
  /** Public business failure rendered through the existing tool error path. */
  get value() { return { code: this.code, message: this.message, retry: this.retry } }
}
function jsonObject(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined
}
function workflowResultFits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] }), 'utf8') <= 2 * 1024 * 1024 - 16 * 1024
}

/** Immutable identity returned by the authoritative executor bridge. */
export interface DiagnosticBinding {
  diagnosticWorkflowVersion?: 1
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
  /** Supported workflow versions, advertised only by the complete bridge implementation. */
  diagnosticWorkflowVersions?: readonly number[]
  /** Prepare scoped work over caller transport without holding the root transaction. */
  prepareWorkers?(root: Agent, assignment: DiagnosticAssignment, args: unknown, execution: ToolExecution): Promise<unknown>
  /** Wait for the already returned closeout's durable acceptance receipt. */
  awaitCloseout?(root: SessionId, producer: SessionId, signal: AbortSignal): Promise<void>
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
    /** Frozen requested scope and its caller-prepared assignment. */
    'diagnostic/worker-request': { runId: string; request: DiagnosticWorkerRequest; assignmentId?: string }
    /** Immutable caller-normalized worker packet in root history. */
    'diagnostic/worker-report': Omit<DiagnosticPublication, 'sessionId'> & { reportRef: string; sha256: string }
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
      preserveOutputLimit: true,
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
    const disposeStatus = this.ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || agent.session.header.sessionPolicy !== DIAGNOSTIC_POLICY) return
      const rootId = agent.session.header.parentSession ?? agent.id
      void this.refresh(rootId).then(async () => {
        const root = this.root(rootId), run = this.run(root.session)
        if (agent === root
          && run?.admission.diagnosticWorkflowVersion === 1
          && this.executor?.closed?.(rootId, rootId, run.admission.coordinatorAssignment.assignmentId)
          && run.activeChildren > 0)
          await this.cancel(rootId)
      }).catch(() => {})
    })
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
      disposeStatus()
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
      diagnosticWorkflowVersions?: number[]
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
      ...(this.executor.diagnosticWorkflowVersions?.includes(1)
        && this.executor.prepareWorkers
        && this.executor.awaitCloseout ? { diagnosticWorkflowVersions: [1] } : {}),
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
    if (agent !== member.root || this.run(member.root.session)?.admission.diagnosticWorkflowVersion === 1) return
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
    admission: DiagnosticAdmission
  }> {
    if (jsonObject(input)?.diagnosticWorkflowVersion !== undefined
      && (jsonObject(input)?.diagnosticWorkflowVersion !== 1
      || !this.capability()?.diagnosticWorkflowVersions?.includes(1)))
      throw new DiagnosticError('diagnostic-capability-unavailable', 'Diagnostic workflow version is unavailable')
    const admission = diagnosticAdmissionSchema.parse(input)
    const root = this.root(SessionId(admission.rootSessionId))
    this.requireCompaction(root)
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
          duplicate: true, admission: prior.admission,
        }
      }
      parseDiagnosticAdmission(admission, Date.now())
      if (this.capability() === undefined)
        throw new DiagnosticError('diagnostic-capability-unavailable', 'Diagnostic child capability is unavailable')
      if (root.status !== 'idle' || root.session.events.some(event => event.type === 'turn/start'))
        throw new DiagnosticError('diagnostic-policy-rejected', 'Admission requires a fresh idle root')
      const binding = this.requireExecutor().binding(root.id)
      if (binding.diagnosticWorkflowVersion !== admission.diagnosticWorkflowVersion)
        throw new DiagnosticError('diagnostic-capability-unavailable', 'Executor and core diagnostic workflow opt-in must agree')
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
        duplicate: false, admission,
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
      const acceptedCloseout = run.admission.diagnosticWorkflowVersion === 1
        && this.executor?.closed?.(rootId, SessionId(childId), record.assignmentId) === true
      const idle = child ? child.status === 'idle' : acceptedCloseout || terminal !== undefined && terminal.seq > (start?.seq ?? -1)
      const quiescent =
        idle &&
        activeModelRequests === 0 &&
        caller.activeCalls === 0 &&
        caller.pendingResults === 0 &&
        record.state === 'accepted'
      const completed = quiescent && (acceptedCloseout || terminal?.type === 'turn/end' && terminal.data.reason.kind === 'completed')
      const state =
        record.state === 'uncertain' || events === undefined
          ? 'uncertain'
          : completed
            ? 'settled'
            : quiescent
              ? terminal?.type === 'turn/end' && terminal.data.reason.kind === 'aborted' ? 'cancelled' : 'failed'
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
      !(run.admission.diagnosticWorkflowVersion === 1
        && this.assignments(root.session).some(record => record.childSessionId
        && this.executor?.closed?.(root.id, SessionId(record.childSessionId), record.assignmentId)
        && !root.session.events.some(event => event.type === 'diagnostic/worker-report'
        && event.data.assignmentId === record.assignmentId))) &&
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

  /**
   * Verify diagnostic presentation metadata against the admitted parent run.
   * @param parent - exact live parent owner.
   * @param child - native child session resolved by the continuation owner.
   * @param runId - caller's admitted run identity, required for diagnostic children.
   */
  assertTitleAuthority(parent: Agent, child: Session, runId?: string): void {
    if (child.header.sessionPolicy !== DIAGNOSTIC_POLICY) {
      if (runId !== undefined) throw new DiagnosticError('diagnostic-parent-stale', 'Child has no diagnostic run')
      return
    }
    const member = child.events.findLast(event => event.type === 'diagnostic/member')
    const reservation = this.assignments(parent.session).find(value => value.childSessionId === child.id
      && member?.type === 'diagnostic/member' && value.assignmentId === member.data.assignmentId)
    if (member?.type !== 'diagnostic/member' || reservation === undefined || reservation.state !== 'accepted'
      || member.data.rootSessionId !== parent.id || child.header.parentSession !== parent.id
      || this.run(parent.session)?.runId !== runId || reservation.runId !== runId || member.data.runId !== runId)
      throw new DiagnosticError('diagnostic-parent-stale', 'Child title requires the admitted parent run')
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

  private requireCompaction(agent: Agent): void {
    const compaction = agent.ctx.get('compaction') as {
      supports?(session: Session): boolean
      compactForOutputBudget?: unknown
    } | undefined
    if (typeof compaction?.compactForOutputBudget !== 'function' || compaction.supports?.(agent.session) === false)
      throw new DiagnosticError('diagnostic-capability-unavailable', 'Diagnostic sessions require the host compaction service scoped to their session policy')
  }

  private install(agent: Agent): void {
    this.installations.get(agent.id)?.()
    const member = this.membership(agent)
    const disposers: (() => void)[] = []
    disposers.push(agent.ctx.tools.restrict({ allow: [] }))
    const allowedTools = new Set<string>(member?.assignment.authority.tools ?? [])
    // Child-local plugins register after inherited-tool restrictions are applied.
    disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      assembly.tools = assembly.tools.filter(tool => allowedTools.has(tool.name))
      return assembly
    }))
    disposers.push(agent.ctx.tools.guard(execution => allowedTools.has(execution.name)
      ? undefined : 'Tool exceeds the diagnostic assignment'))
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
          if (this.run(member.root.session)?.admission.diagnosticWorkflowVersion === 1
            && this.executor?.closed?.(member.root.id, agent.id, member.assignment.assignmentId))
            throw new DiagnosticError('diagnostic-policy-rejected', 'Accepted closeout is terminal; reconcile retained history')
        }
      }),
    )
    if (member !== undefined) {
      this.requireCompaction(agent)
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
      if (limits.diagnosticWorkflowVersion === 1) {
        disposers.push(agent.ctx.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          if (this.executor?.closed?.(member.root.id, agent.id, member.assignment.assignmentId)) return { kind: 'reject' }
          return decision
        }))
        disposers.push(agent.ctx.on('agent/turn-stopping', async ({ signal }) => {
          const executor = this.requireExecutor()
          if (!executor.awaitCloseout) throw new DiagnosticError('diagnostic-capability-unavailable', 'Terminal closeout is unavailable')
          await executor.awaitCloseout(member.root.id, agent.id, signal)
        }))
      }
      if (agent === member.root && limits.diagnosticWorkflowVersion === 1) {
        const failures = new WeakMap<object, DiagnosticWorkflowError>()
        disposers.push(agent.ctx.on('tools/post-execute', async (execution, result, next) => {
          const finalized = await next()
          const error = failures.get(execution)
          if (!error || !result.isError) return finalized
          return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify({ error: error.value }) }] }
        }))
        const tools = [
          ['dispatch_workers', 'Launch focused independent workers.', diagnosticDispatchSchema, (args: unknown, execution: ToolExecution) => this.dispatchWorkers(agent, args, execution)],
          ['wait_for_workers', 'Wait for any worker report or terminal change.', diagnosticWaitSchema, (args: unknown, execution: ToolExecution) => this.waitForWorkers(agent, args, execution.signal)],
          ['read_worker_report', 'Read an immutable worker report page.', diagnosticReadReportSchema, (args: unknown) => this.readWorkerReport(agent, args)],
        ] as const
        for (const [name, description, schema, execute] of tools) disposers.push(agent.ctx.tools.register({
          name, description, parameters: z.toJSONSchema(schema),
          output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args, execution) => {
            try { return await execute(args, execution) }
            catch (error) {
              const failure = error instanceof z.ZodError ? new DiagnosticWorkflowError('invalid_request', error.message) : error
              if (failure instanceof DiagnosticWorkflowError) failures.set(execution, failure)
              throw failure
            }
          },
        }))
      }
      if (agent === member.root && limits.diagnosticWorkflowVersion !== 1) {
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

  private workflow(root: Agent): RunData {
    const run = this.requireRun(root)
    if (run.admission.diagnosticWorkflowVersion !== 1)
      throw new DiagnosticWorkflowError('authority_denied', 'This run did not opt in to diagnostic workflow v1')
    return run
  }

  private workflowRequests(root: Agent) {
    return root.session.events.filter(event => event.type === 'diagnostic/worker-request')
  }

  private async dispatchWorkers(root: Agent, input: unknown, execution: ToolExecution): Promise<JsonValue> {
    const args = diagnosticDispatchSchema.parse(input)
    const run = this.workflow(root)
    const workers: JsonValue[] = []
    const conflicts = new Set<string>()
    await this.transact(root.id, async () => {
      for (const request of args.requests) {
        const prior = this.workflowRequests(root).find(event => event.data.request.requestKey === request.requestKey)
        if (prior && diagnosticCanonicalJson(prior.data.request) !== diagnosticCanonicalJson(request)) conflicts.add(request.requestKey)
        else if (!prior) root.session.append('diagnostic/worker-request', { runId: run.runId, request })
      }
      await this.flush(root.session)
    })
    const needsPreparation = args.requests.some(request => !conflicts.has(request.requestKey)
      && !this.workflowRequests(root).findLast(event => event.data.request.requestKey === request.requestKey)?.data.assignmentId)
    // The original native arguments and call identity cross the existing executor unchanged.
    const executor = this.requireExecutor()
    if (!executor.prepareWorkers) throw new DiagnosticError('diagnostic-capability-unavailable', 'Worker preparation is unavailable')
    const preparation = needsPreparation
      ? diagnosticPreparationSchema.parse(await executor.prepareWorkers(root, run.admission.coordinatorAssignment, args, execution))
      : undefined
    if (preparation
      && (preparation.prepared.length !== args.requests.length
      || preparation.prepared.some((item, index) => item.requestKey !== args.requests[index]?.requestKey)))
      throw new DiagnosticWorkflowError('assignment_rejected', 'Preparation must return each requestKey in request order')
    for (const [index, request] of args.requests.entries()) {
      execution.signal.throwIfAborted()
      try {
        if (conflicts.has(request.requestKey)) throw new DiagnosticWorkflowError('request_conflict', `requestKey ${request.requestKey} already has a different scope`)
        const prior = this.workflowRequests(root).findLast(event => event.data.request.requestKey === request.requestKey)
        let assignmentId = prior?.data.assignmentId
        if (assignmentId === undefined) {
          const item = preparation?.prepared[index]
          if (!item) throw new DiagnosticWorkflowError('assignment_rejected', `Missing preparation for ${request.requestKey}`)
          if (item.status === 'rejected') { workers.push(item); continue }
          assignmentId = item.assignmentId
          await this.transact(root.id, async () => {
            const assignment = this.assignments(root.session).find(value => value.assignmentId === assignmentId)
            if (!assignment || assignment.assignment.role !== request.role)
              throw new DiagnosticWorkflowError('assignment_rejected', `Prepared assignment ${assignmentId} must belong to this run and role ${request.role}`)
            const existing = this.workflowRequests(root).findLast(event => event.data.request.requestKey === request.requestKey
              && event.data.assignmentId !== undefined)
            if (existing && existing.data.assignmentId !== assignmentId)
              throw new DiagnosticWorkflowError('request_conflict', `requestKey ${request.requestKey} already resolves to assignment ${existing.data.assignmentId}`)
            const owner = this.workflowRequests(root).find(event => event.data.assignmentId === assignmentId)
            if (owner && owner.data.request.requestKey !== request.requestKey)
              throw new DiagnosticWorkflowError('assignment_rejected', `Assignment ${assignmentId} already belongs to another requestKey`)
            root.session.append('diagnostic/worker-request', { runId: run.runId, request, assignmentId: item.assignmentId })
            await this.flush(root.session)
          })
        }
        const launched = await this.deliver(root, { assignmentId, run_in_background: true }, execution.signal, false)
        if (typeof launched.childSessionId !== 'string') throw new Error('Native delivery did not retain its child identity')
        workers.push({ requestKey: request.requestKey, status: 'started', assignmentId, childSessionId: launched.childSessionId })
      } catch (error) {
        execution.signal.throwIfAborted()
        if (!(error instanceof DiagnosticError || error instanceof DiagnosticWorkflowError)) throw error
        const failure = error instanceof DiagnosticWorkflowError ? error : new DiagnosticWorkflowError(
          error.code === 'diagnostic-child-unsettled' ? 'reconciliation_required' : error.code === 'diagnostic-budget-exhausted' ? 'run_limit_reached' : 'assignment_rejected',
          error.code === 'diagnostic-budget-exhausted' ? `${error.message}; run limits: ${run.admission.maxModelRequests} model requests, ${run.admission.maxOutputTokens} output tokens, deadline ${run.admission.deadline}` : error.message, error.code === 'diagnostic-child-unsettled' ? 'after_reconciliation' : 'never')
        workers.push({ requestKey: request.requestKey, status: 'rejected', error: failure.value })
      }
    }
    return { workers }
  }

  /**
   * Retain a caller-normalized packet against the exact committed native closeout.
   * @param input - root, assignment, receipt identity and immutable packet.
   * @returns stable report reference and root-history sequence.
   */
  async publishWorkerReport(input: unknown): Promise<DiagnosticPublicationResult> {
    const args = diagnosticPublishSchema.parse(input)
    diagnosticCanonicalJson(args)
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 2 * 1024 * 1024 - 16 * 1024) throw new DiagnosticWorkflowError('invalid_request', 'Publication exceeds the existing 2 MiB complete message envelope')
    const root = this.root(SessionId(args.sessionId))
    return this.transact(root.id, async () => {
      const run = this.run(root.session)
      if (!run || run.runId !== args.runId || run.admission.diagnosticWorkflowVersion !== 1)
        throw new DiagnosticWorkflowError('authority_denied', 'Publication requires the admitted root and workflow run')
      const record = this.assignments(root.session).find(value => value.assignmentId === args.assignmentId)
      if (!record
        || record.state !== 'accepted'
        || record.childSessionId !== args.childSessionId
        || args.closeoutRef.producerSessionId !== args.childSessionId)
        throw new DiagnosticWorkflowError('authority_denied', 'Publication assignment and child must belong to this root run')
      const prior = root.session.events.find(event => event.type === 'diagnostic/worker-report'
        && event.data.runId === args.runId
        && event.data.assignmentId === args.assignmentId
        && event.data.closeoutRef.executorCorrelationId === args.closeoutRef.executorCorrelationId)
      if (prior?.type === 'diagnostic/worker-report') {
        if (diagnosticCanonicalJson(prior.data.packet) !== diagnosticCanonicalJson(args.packet)
          || diagnosticCanonicalJson(prior.data.closeoutRef) !== diagnosticCanonicalJson(args.closeoutRef))
          throw new DiagnosticWorkflowError('report_conflict', `Closeout ${args.closeoutRef.executorCorrelationId} already has different published content`)
        await this.flush(root.session)
        return { reportRef: prior.data.reportRef, eventSeq: prior.seq, duplicate: true }
      }
      const executorRecords = root.session.events.filter(event => event.type === 'diagnostic/executor')
      const receipt = executorRecords.find(event => event.data.kind === 'receipt'
        && jsonObject(event.data.value)?.executorCorrelationId === args.closeoutRef.executorCorrelationId)
      const accepted = receipt && jsonObject(receipt.data.value)
      if (!accepted
        || accepted.state !== 'succeeded'
        || accepted.producerSessionId !== args.childSessionId
        || accepted.assignmentId !== args.assignmentId
        || accepted.callEventSeq !== args.closeoutRef.callEventSeq
        || accepted.resultEventSeq !== args.closeoutRef.resultEventSeq)
        throw new DiagnosticWorkflowError('report_unavailable', 'closeoutRef must identify a committed successful acceptance receipt', 'after_reconciliation')
      const resultRecord = executorRecords.find(event => event.data.kind === 'result'
        && jsonObject(jsonObject(event.data.value)?.call)?.executorCorrelationId === args.closeoutRef.executorCorrelationId)
      const result = jsonObject(resultRecord?.data.value)
      const call = jsonObject(result?.call)
      const outcome = jsonObject(result?.result)
      if (call?.tool !== 'closeout_json'
        || call.producerSessionId !== args.childSessionId
        || call.childSessionId !== args.childSessionId
        || call.runId !== args.runId
        || call.assignmentId !== args.assignmentId
        || outcome?.ok !== true
        || diagnosticRecordDigest(outcome) !== accepted.resultDigest)
        throw new DiagnosticWorkflowError('report_unavailable', 'closeoutRef does not identify an accepted closeout_json')
      const child = this.service('agents').get(SessionId(args.childSessionId))
      const events = child?.session.events ?? (await this.service('sessionPersistence').load(SessionId(args.childSessionId))).events
      const nativeCall = events.find(event => event.seq === args.closeoutRef.callEventSeq)
      const nativeResult = events.find(event => event.seq === args.closeoutRef.resultEventSeq)
      if (nativeCall?.type !== 'tool/call'
        || nativeCall.data.name !== 'closeout_json'
        || nativeResult?.type !== 'tool/result'
        || nativeResult.data.message.content.some(block => block.type === 'tool-result'
        && block.isError)
        || nativeResult.data.message.source.callId !== nativeCall.data.callId
        || nativeResult.data.turn !== nativeCall.data.turn
        || nativeResult.data.step !== nativeCall.data.step)
        throw new DiagnosticWorkflowError('report_unavailable', 'Native closeout call/result evidence is missing or unsuccessful')
      const nativeBlock = nativeResult.data.message.content.find(block => block.type === 'tool-result')
      const content = nativeBlock?.content
      let acknowledged: unknown
      try { acknowledged = content?.length === 1 && content[0]?.type === 'text' ? JSON.parse(content[0].text) : undefined }
      catch { throw new DiagnosticWorkflowError('report_unavailable', 'Native closeout acknowledgement is not JSON') }
      if (!isDeepStrictEqual(acknowledged, outcome.value) || !isDeepStrictEqual(JSON.parse(nativeCall.data.arguments), call.arguments))
        throw new DiagnosticWorkflowError('report_unavailable', 'Native closeout content differs from its accepted receipt')
      const reportRef = `${root.id}:${randomUUID()}`
      const { sessionId: _sessionId, ...identity } = args
      const event = root.session.append('diagnostic/worker-report', { ...identity, reportRef, sha256: diagnosticRecordDigest(args.packet) })
      await this.flush(root.session)
      return { reportRef, eventSeq: event.seq, duplicate: false }
    })
  }

  private async readWorkerReport(root: Agent, input: unknown): Promise<JsonValue> {
    this.workflow(root)
    const { reportRef, offset = 0 } = diagnosticReadReportSchema.parse(input)
    const event = root.session.events.find(event => event.type === 'diagnostic/worker-report' && event.data.reportRef === reportRef)
    if (event?.type !== 'diagnostic/worker-report') {
      const ownerId = reportRef.slice(0, -37)
      if (/^[A-Za-z0-9._:-]{1,128}$/.test(ownerId) && ownerId !== root.id && /:[a-f0-9-]{36}$/.test(reportRef)) {
        let ownerEvents = this.service('agents').get(SessionId(ownerId))?.session.events
        if (!ownerEvents) {
          try { ownerEvents = (await this.service('sessionPersistence').load(SessionId(ownerId))).events }
          catch { /* An unavailable owner cannot establish this opaque reference. */ }
        }
        if (ownerEvents?.some(event => event.type === 'diagnostic/worker-report' && event.data.reportRef === reportRef))
          throw new DiagnosticWorkflowError('authority_denied', 'Report reference belongs to another run')
      }
      throw new DiagnosticWorkflowError('report_unavailable', `Unknown reportRef ${reportRef}`)
    }
    const text = diagnosticCanonicalJson(event.data.packet)
    if (offset > text.length) throw new DiagnosticWorkflowError('invalid_request', `offset ${offset} exceeds report length ${text.length}`)
    const page = (end: number) => ({
      reportRef, offset, nextOffset: end === text.length ? null : end, text: text.slice(offset, end), sha256: event.data.sha256,
    })
    let low = offset, high = text.length
    while (low < high) {
      const end = Math.ceil((low + high) / 2)
      if (workflowResultFits(page(end))) low = end
      else high = end - 1
    }
    if (low === offset
      && offset < text.length) throw new DiagnosticWorkflowError('invalid_request', 'Report reference leaves no room for a page')
    return page(low)
  }

  private workerUpdates(root: Agent, input: z.infer<typeof diagnosticWaitSchema>): JsonValue {
    this.workflow(root)
    const assignments = this.assignments(root.session).filter(
      (record): record is AssignmentData & { childSessionId: string } => record.childSessionId !== undefined,
    )
    if (input.assignmentIds?.some(id => !assignments.some(record => record.assignmentId === id)))
      throw new DiagnosticWorkflowError('authority_denied', 'assignmentIds must name launched workers belonging to this run')
    const selected = assignments.filter(record => input.assignmentIds === undefined || input.assignmentIds.includes(record.assignmentId))
    const ids = new Set(selected.map(record => record.assignmentId))
    const reports = new Map<string, { reportRef: string; seq: number }>()
    const terminal = new Map<string, { state: string; seq: number }>()
    const emitted = new Set<string>()
    const updates: JsonValue[] = []
    let nextSeq = input.afterSeq
    const activeAssignmentIds = selected.filter((record) => {
      const state = root.session.events.findLast(event => event.type === 'diagnostic/child-state'
        && jsonObject(event.data)?.assignmentId === record.assignmentId)
      const value = state && jsonObject(state.data)
      const published = root.session.events.some(event => event.type === 'diagnostic/worker-report'
        && event.data.assignmentId === record.assignmentId)
      return value?.quiescent !== true || value.state === 'settled' && !published
    }).map(record => record.assignmentId)
    const value = () => ({ updates, nextSeq, activeAssignmentIds, idle: activeAssignmentIds.length === 0 })
    for (const event of root.session.events) {
      const batch: JsonValue[] = []
      if (event.type === 'diagnostic/worker-report') reports.set(event.data.assignmentId, { reportRef: event.data.reportRef, seq: event.seq })
      if (event.type === 'diagnostic/child-state') {
        const data = jsonObject(event.data)
        if (typeof data?.assignmentId === 'string' && data.quiescent === true)
          terminal.set(data.assignmentId, { state: String(data.state), seq: event.seq })
      }
      for (const record of selected) {
        if (!ids.has(record.assignmentId)) continue
        const report = reports.get(record.assignmentId), end = terminal.get(record.assignmentId)
        const identity = { seq: event.seq, assignmentId: record.assignmentId,
          childSessionId: record.childSessionId, role: record.assignment.role }
        const add = (kind: string, extra: Record<string, JsonValue>) => {
          const key = `${record.assignmentId}:${kind}`
          if (!emitted.has(key)) {
            emitted.add(key)
            if (event.seq > input.afterSeq) batch.push({ ...identity, kind, ...extra })
          }
        }
        if (report) add('report_available', { reportRef: report.reportRef })
        if (end && report && end.state === 'settled') add('completed', { reportRef: report.reportRef })
        else if (end && end.state !== 'settled') add(end.state === 'cancelled' ? 'cancelled' : 'failed', { error: { code: 'assignment_rejected', message: `Worker ${record.assignmentId} ended without a completed report (${end.state})`, retry: 'never' } })
      }
      if (event.seq <= input.afterSeq) continue
      if (batch.length && !workflowResultFits({ ...value(), updates: [...updates, ...batch], nextSeq: event.seq })) {
        if (!updates.length) throw new DiagnosticWorkflowError('invalid_request', 'A complete worker update exceeds the transport envelope')
        break
      }
      updates.push(...batch)
      nextSeq = event.seq
    }
    return value()
  }

  private async waitForWorkers(root: Agent, input: unknown, signal: AbortSignal): Promise<JsonValue> {
    const args = diagnosticWaitSchema.parse(input)
    // Subscribe before checking history, including across persistence awaits.
    while (true) {
      signal.throwIfAborted()
      const wake = Promise.withResolvers<void>()
      const dispose = this.ctx.on('session/event', (session) => { if (session === root.session) wake.resolve() })
      const abort = () => wake.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      try {
        const result = this.workerUpdates(root, args) as { updates: JsonValue[]; idle: boolean }
        if (result.updates.length || result.idle) { await this.flush(root.session); return result }
        await wake.promise
      } finally { dispose(); signal.removeEventListener('abort', abort) }
    }
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
      if (run.admission.diagnosticWorkflowVersion === 1) {
        const launched = this.assignments(root.session).filter(value => value.childSessionId !== undefined).length
        if (launched >= run.admission.maxChildren)
          throw new DiagnosticWorkflowError('run_limit_reached', `Run child limit ${run.admission.maxChildren} reached; start a new run`)
        if (active.length >= run.admission.maxConcurrentChildren)
          throw new DiagnosticWorkflowError('capacity_unavailable', `Concurrent child limit ${run.admission.maxConcurrentChildren} reached; wait for a worker result`, 'after_worker_result')
      }
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
      if (options.purpose !== undefined && options.purpose !== 'compaction')
        throw new DiagnosticError('diagnostic-policy-rejected', 'Diagnostic auxiliary requests must be compaction')
      {
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
        maxTokens > member.assignment.roleSettings.outputLimit ||
        options.purpose === undefined && maxTokens !== member.assignment.roleSettings.outputLimit
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
