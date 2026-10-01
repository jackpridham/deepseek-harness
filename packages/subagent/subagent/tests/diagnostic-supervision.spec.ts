/** Supervision uses native worker turns and durable inbox delivery. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { SpillStore, SpillLocator } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Compaction from '@deepseek-ai/dsh-compaction-basic'
import Meter from '@deepseek-ai/dsh-token-meter'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Subagents, { DIAGNOSTIC_POLICY, diagnosticCanonicalJson, diagnosticRecordDigest, parseDiagnosticAdmission } from '../src/index.ts'
import type { DiagnosticBinding, DiagnosticAssignment } from '../src/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const dispose of cleanup.splice(0)) await dispose() })
interface RecoveryHooks { awaitCloseout?: () => Promise<void> }
interface InspectionFixture {
  assignmentObjective?: string
  closeoutAfter?: number
  maxModelRequests?: number
  paths?: string[]
  sourceFailureMessage?: string
}

async function setup(supervised = true, review = false, workers = 1, recovery = false, recoveryMode: 'accepted' | 'missing' | 'rejected' | 'json' = 'accepted', hooks: RecoveryHooks = {}, inspection: InspectionFixture = {}) {
  const ctx = new Context()
  const directory = mkdtempSync(join(tmpdir(), 'dsh-supervision-'))
  const release = Promise.withResolvers<boolean>(), reading = Promise.withResolvers<AbortSignal>()
  cleanup.push(async () => { release.resolve(true); await ctx.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: directory, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Meter)
  await ctx.plugin(Compaction, { sessionPolicies: [DIAGNOSTIC_POLICY], thresholdRatio: 0.65 })
  await ctx.plugin(Projections)
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/diagnostic-assignments.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const input = parseDiagnosticAdmission(fixtures['admit-run'], Date.parse('2030-01-01'))
  const prepared = fixtures['prepare-discovery'] as { runId: string; rootSessionId: string; idempotencyKey: string; assignment: DiagnosticAssignment }
  if (inspection.assignmentObjective !== undefined) prepared.assignment.objective = inspection.assignmentObjective
  if (inspection.maxModelRequests !== undefined) {
    input.maxModelRequests = inspection.maxModelRequests + input.rootSynthesisReserveRequests
    input.coordinatorAssignment.budget.maxModelRequests = inspection.maxModelRequests
    prepared.assignment.budget.maxModelRequests = inspection.maxModelRequests
  }
  input.maxConcurrentChildren = workers
  input.diagnosticWorkflowVersion = 1
  if (review) input.diagnosticReviewVersion = 1
  if (recovery) input.diagnosticCloseoutRecoveryVersion = 1
  input.coordinatorAssignment.authority.tools = ['read', 'glob', 'grep', 'closeout_json', 'dispatch_workers', 'wait_for_workers', 'read_worker_report']
  if (supervised) {
    input.diagnosticSupervisionVersion = 1
    input.coordinatorAssignment.authority.tools.push('inspect_worker', 'send_message', 'update_progress')
    prepared.assignment.authority.tools.push('update_progress')
  }
  for (const assignment of [input.coordinatorAssignment, prepared.assignment]) assignment.digest = diagnosticRecordDigest(assignment, true)
  const script = [
    ...Array.from({ length: workers }, (_, i) => toolCallResponse('source-' + i, 'read', {})),
    ...(supervised && !recovery ? [toolCallResponse('progress', 'update_progress', { resolved: ['Scope checked'], uncertain: ['Missing source'], nextCheck: 'Report the unresolved source' })] : []),
    ...(recovery
      ? recoveryMode === 'missing'
        ? [textResponse('I inspected the source but have not submitted a report.'), textResponse('Still no closeout.')]
        : recoveryMode === 'rejected'
          ? [toolCallResponse('rejected-closeout', 'closeout_json', { report: {} }), textResponse('Corrected prose but no closeout.'), toolCallResponse('accepted-closeout', 'closeout_json', { report: {} })]
          : [textResponse(recoveryMode === 'json' ? '{\"summary\":\"plain JSON is not a closeout\"}' : 'I inspected the source but have not submitted a report.'), toolCallResponse('recovered-closeout', 'closeout_json', { report: {} })]
      : [toolCallResponse('closeout', 'closeout_json', { report: {} })]),
  ]
  const adapter = new MockAdapter(script)
  adapter.resolveModel = async (provider, model) => {
    const contextWindow = input.coordinatorAssignment.commonModel.contextWindow
    return { provider, id: model, name: model, context: { contextWindow },
      contextOptions: { defaultContextWindow: contextWindow, contextWindows: [{ contextWindow, available: true }] } }
  }
  ctx.llm.registerAdapter([input.coordinatorAssignment.commonModel.provider], adapter)
  let binding: DiagnosticBinding = { executorBindingId: input.executorBindingId, bindingEpoch: 1,
    runId: input.runId, rootSessionId: input.rootSessionId,
    comparisonDigest: input.comparisonDigest, sourceRefs: input.sourceRefs, state: 'awaiting-admission', diagnosticWorkflowVersion: 1,
    ...(supervised ? { diagnosticSupervisionVersion: 1 as const } : {}), ...(review ? { diagnosticReviewVersion: 1 as const } : {}),
    ...(recovery ? { diagnosticCloseoutRecoveryVersion: 1 as const } : {}) }
  const closed = new Set<string>()
  let closeoutAttempts = 0, acceptedCloseouts = 0
  let preparations = 0
  ctx.subagents.diagnostics.registerExecutor({
    diagnosticWorkflowVersions: [1], diagnosticSupervisionVersions: [1], diagnosticReviewVersions: [1],
    diagnosticCloseoutRecoveryVersions: [1],
    diagnosticCheckpointVersions: [1], binding: () => binding,
    withCheckpoint: async (_root, capture) => capture({ binding: {}, acceptedState: { receipts: [], reads: [] } }),
    admit: async () => { binding = { ...binding, state: 'active' } },
    prepareWorkers: async (_root, _assignment, args) => {
      const value = structuredClone(prepared)
      if (preparations++) {
        value.assignment.assignmentId += '-' + preparations
        value.assignment.digest = diagnosticRecordDigest(value.assignment, true)
        value.idempotencyKey += '-' + preparations
      }
      await ctx.subagents.diagnostics.prepare(value)
      return { prepared: [{ requestKey: (args as { requests: { requestKey: string }[] }).requests[0]!.requestKey, status: 'prepared', assignmentId: value.assignment.assignmentId }] }
    },
    awaitCloseout: async () => { await hooks.awaitCloseout?.() }, closed: (_root, producer) => closed.has(producer),
    cancel: async () => {}, quiescent: () => true,
    install: (agent) => {
      const disposers = ['read', 'closeout_json'].map(name => agent.ctx.tools.register({ name, description: name, parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (_args, execution) => {
          if (name === 'read') { reading.resolve(execution.signal); await release.promise; throw new Error(inspection.sourceFailureMessage ?? 'Source is unavailable') }
          if (recoveryMode === 'rejected' && closeoutAttempts++ === 0) throw new Error('Caller rejected this closeout')
          if (++acceptedCloseouts >= (inspection.closeoutAfter ?? 1)) { closed.add(agent.id); execution.concludeTurn() }
          return { accepted: true }
        },
      }))
      return () => { disposers.forEach((dispose) => { dispose() }) }
    },
  })
  const { agent: root } = await ctx.agents.create({ sessionId: SessionId(input.rootSessionId), meta: { sessionPolicy: DIAGNOSTIC_POLICY } })
  await ctx.subagents.diagnostics.admit(input)
  const execute = (name: string, args: object, agent = root) => ctx.tools.execute({ name, callId: CallId('test-' + name), agent, arguments: args, signal: new AbortController().signal })
  const dispatch = await execute('dispatch_workers', { requests: [{ requestKey: 'worker', name: 'Guard check', role: 'discovery', objective: 'Inspect source', namespace: '', responsibility: '', paths: inspection.paths ?? [] }] })
  expect(dispatch.isError, JSON.stringify(dispatch)).toBe(false)
  const signal = await reading.promise
  const childId = root.session.events.findLast(event => event.type === 'diagnostic/reservation')!.data.childSessionId!
  const child = ctx.agents.get(SessionId(childId))!
  const assignmentId = prepared.assignment.assignmentId
  return { ctx, root, child, execute, release, signal, input, prepared, assignmentId, adapter, script, closed,
    setBinding: (value: DiagnosticBinding) => { binding = value } }
}

it('recovers a normally completed worker with one durable reminder and an accepted closeout', async () => {
  const { ctx, child, release, closed } = await setup(false, false, 1, true)
  release.resolve(true)
  await child.whenIdle()

  const recovery = child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery')
  expect(recovery).toHaveLength(2)
  expect(recovery.map(event => event.data.state)).toEqual(['pending', 'queued'])
  expect(recovery[0]!.data.message.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Plain assistant text') })
  expect(child.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'closeout_json')).toHaveLength(1)
  expect(closed.has(child.id)).toBe(true)
  await agentEvents(ctx, child).serial('agent/turn-stopping', { turn: 1, reason: { kind: 'completed' }, signal: new AbortController().signal })
  expect(child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery')).toHaveLength(2)
})

it('treats assistant JSON prose as missing closeout and recovers it once', async () => {
  const { child, release, closed } = await setup(false, false, 1, true, 'json')
  release.resolve(true)
  await child.whenIdle()
  expect(child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery')).toHaveLength(2)
  expect(closed.has(child.id)).toBe(true)
})

it('awaits pending acceptance before recovery, and acceptance wins without a reminder', async () => {
  const entered = Promise.withResolvers<boolean>(), settled = Promise.withResolvers<boolean>()
  let hold = false
  const { child, release, closed } = await setup(false, false, 1, true, 'accepted', {
    awaitCloseout: async () => { if (hold) { entered.resolve(true); await settled.promise } },
  })
  hold = true
  release.resolve(true)
  await entered.promise
  closed.add(child.id)
  settled.resolve(true)
  await child.whenIdle()
  expect(child.session.events.some(event => event.type === 'diagnostic/closeout-recovery')).toBe(false)
})

it('does not recover a coordinator after its terminal closeout is accepted', async () => {
  const { ctx, root, execute } = await setup(false, false, 1, true)
  expect((await execute('closeout_json', {}, root)).isError).toBe(false)
  await agentEvents(ctx, root).serial('agent/turn-stopping', { turn: 1, reason: { kind: 'completed' }, signal: new AbortController().signal })
  expect(root.session.events.some(event => event.type === 'diagnostic/closeout-recovery')).toBe(false)
})

it('retains a single queued reminder after its flush acknowledgement is lost', async () => {
  const { ctx, child } = await setup(false, false, 1, true)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let fail = true
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (...args) => {
    if (fail && child.session.events.some(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step')) {
      fail = false
      throw new Error('lost queued acknowledgement')
    }
    return flush(...args)
  })
  const payload = { turn: 1, reason: { kind: 'completed' as const }, signal: new AbortController().signal }
  await expect(agentEvents(ctx, child).serial('agent/turn-stopping', payload)).rejects.toThrow('lost queued acknowledgement')
  spy.mockRestore()
  await agentEvents(ctx, child).serial('agent/turn-stopping', payload)
  expect(child.session.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step')).toHaveLength(1)
  expect(child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery')).toHaveLength(1)
})

it('keeps an intent-only interrupted reminder uncertain and never re-enqueues it', async () => {
  const { ctx, child } = await setup(false, false, 1, true)
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let fail = true
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (...args) => {
    if (fail && child.session.events.some(event => event.type === 'diagnostic/closeout-recovery')) {
      fail = false
      throw new Error('interrupted before reminder delivery')
    }
    return flush(...args)
  })
  const payload = { turn: 1, reason: { kind: 'completed' as const }, signal: new AbortController().signal }
  await expect(agentEvents(ctx, child).serial('agent/turn-stopping', payload)).rejects.toThrow('interrupted before reminder delivery')
  spy.mockRestore()
  await agentEvents(ctx, child).serial('agent/turn-stopping', payload)
  expect(child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery')).toHaveLength(1)
  expect(child.session.events.some(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step')).toBe(false)
})

it('recovers a rejected closeout followed by normal prose, then accepts the corrected closeout', async () => {
  const { child, release, closed } = await setup(false, false, 1, true, 'rejected')
  release.resolve(true)
  await child.whenIdle()

  expect(child.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'closeout_json')).toHaveLength(2)
  expect(child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery')).toHaveLength(2)
  expect(closed.has(child.id)).toBe(true)
})

it('reports one exhausted recovery reminder to the parent wait projection', async () => {
  const { root, child, execute, release, assignmentId } = await setup(true, false, 1, true, 'missing')
  const afterSeq = root.session.seq - 1
  release.resolve(true)
  await child.whenIdle()

  expect(child.session.events.filter(event => event.type === 'diagnostic/closeout-recovery').map(event => event.data.state)).toEqual(['pending', 'queued', 'missing-report'])
  const wait = await execute('wait_for_workers', { afterSeq, timeoutMs: 1 })
  expect(wait.isError, JSON.stringify(wait)).toBe(false)
  expect(wait.value).toMatchObject({ reason: 'updates' })
  expect((wait.value as { updates: unknown[] }).updates).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'missing_report', assignmentId, childSessionId: child.id })]))
  expect(root.session.events.filter(event => event.type === 'diagnostic/missing-report')).toHaveLength(1)
})

it('does not recover for output caps, cancellation, errors, or blocked stop reasons', async () => {
  const { ctx, child, release } = await setup(false, false, 1, true)
  await agentEvents(ctx, child).serial('agent/turn-stopping', { turn: 1, reason: { kind: 'max-tokens' }, signal: new AbortController().signal })
  await agentEvents(ctx, child).serial('agent/turn-stopping', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } }, signal: new AbortController().signal })
  await agentEvents(ctx, child).serial('agent/turn-stopping', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'request failed' } }, signal: new AbortController().signal })
  await agentEvents(ctx, child).serial('agent/turn-stopping', { turn: 1, reason: { kind: 'blocked' }, signal: new AbortController().signal })
  expect(child.session.events.some(event => event.type === 'diagnostic/closeout-recovery')).toBe(false)
  release.resolve(true)
  await child.whenIdle()
})

it('does not spend a recovery request when remaining output budget is reserved', async () => {
  const { root, child, release, input } = await setup(false, false, 1, true)
  const charge = root.session.events.find(event => event.type === 'diagnostic/request')!
  root.session.append('diagnostic/request', { ...charge.data, id: 'recovery-budget-reservation', state: 'reserved', outputTokens: input.maxOutputTokens })
  release.resolve(true)
  await child.whenIdle()
  expect(child.session.events.some(event => event.type === 'diagnostic/closeout-recovery')).toBe(false)
})

it('keeps recovery disabled for a frozen admission that did not negotiate it', async () => {
  const { child, release } = await setup(false)
  release.resolve(true)
  await child.whenIdle()
  expect(child.session.events.some(event => event.type === 'diagnostic/closeout-recovery')).toBe(false)
})

it('returns a checkpoint without moving the report cursor or cancelling source work', async () => {
  const { root, child, execute, signal, assignmentId } = await setup()
  const afterSeq = root.session.seq - 1
  const wait = await execute('wait_for_workers', { afterSeq, timeoutMs: 5 })
  expect(wait.isError).toBe(false)
  expect(wait.value).toMatchObject({ reason: 'checkpoint', nextSeq: afterSeq, updates: [], activeWorkers: [{ assignmentId, childSessionId: child.id, elapsedMs: expect.any(Number) as unknown }] })
  expect(signal.aborted).toBe(false)
  const inspection = await execute('inspect_worker', { assignmentId })
  expect(inspection.value).toMatchObject({ scope: { objective: expect.any(String) as unknown }, activity: { pendingTools: [{ name: 'read' }] }, progress: null, acceptedCloseout: false })
})

it('returns every oversized inspection field through the formatter without spilling', async () => {
  const count = 51
  const paths = Array.from({ length: count }, (_, index) => `source-${index}/${'p'.repeat(3000)}`)
  const objective = 'Complete scope: ' + 'o'.repeat(60_000)
  const failure = 'source failure: ' + 'f'.repeat(3000)
  const { ctx, child, execute, release, script, assignmentId } = await setup(true, false, 1, false, 'accepted', {}, {
    assignmentObjective: objective, closeoutAfter: count, maxModelRequests: count * 3, paths, sourceFailureMessage: failure,
  })
  await ctx.plugin(PagingSpillStore)
  await ctx.plugin(SpillPolicy, { maxInlineBytes: 50_000 })
  script.splice(1, script.length,
    ...Array.from({ length: count - 1 }, (_, index) => toolCallResponse(`source-${index + 1}`, 'read', {})),
    ...Array.from({ length: count }, (_, index) => toolCallResponse(`closeout-${index}`, 'closeout_json', { report: {} })),
  )
  release.resolve(true)
  await child.whenIdle()

  const result = await execute('inspect_worker', { assignmentId })
  expect(result.isError).toBe(false)
  expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  const rendered = result.content[0]
  if (rendered?.type !== 'text') throw new Error('Expected inspection text')
  expect(Buffer.byteLength(rendered.text, 'utf8')).toBeGreaterThan(50_000)
  expect(rendered.text).not.toContain('Full formatted result stored at:')
  expect((ctx.spillStore as PagingSpillStore).saves).toEqual([])
  const inspection = JSON.parse(rendered.text) as {
    scope: { objective: string; request: { paths: string[] } }
    recentToolFailures: { detail: string }[]
    reportAttempts: unknown[]
  }
  expect(inspection.scope.objective).toBe(objective)
  expect(inspection.scope.request.paths).toEqual(paths)
  expect(inspection.recentToolFailures).toHaveLength(count)
  expect(inspection.recentToolFailures.every(entry => entry.detail.includes(failure))).toBe(true)
  expect(inspection.reportAttempts).toHaveLength(count)
})

it('delivers guidance once after a source call, retains progress separately and keeps closeout terminal', async () => {
  const { ctx, root, child, execute, release, signal, assignmentId, prepared, adapter } = await setup()
  const frozen = JSON.stringify(prepared.assignment)
  const args = { operationId: 'review-1', assignmentId, childSessionId: child.id, message: 'Record the missing source as unresolved; submit your report.' }
  const first = await execute('send_message', args)
  expect(first.isError, JSON.stringify(first)).toBe(false)
  expect(first.value).toMatchObject({ status: 'queued', duplicate: false })
  expect((await execute('send_message', args)).value).toMatchObject({ ...first.value as object, duplicate: true })
  expect((await execute('send_message', { ...args, message: 'Changed scope' })).isError).toBe(true)
  expect(signal.aborted).toBe(false)
  expect(child.session.events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === args.message))).toHaveLength(0)
  release.resolve(true); await child.whenIdle()
  expect((await execute('send_message', args)).value).toMatchObject({ status: 'delivered', duplicate: true })
  const closed = await execute('send_message', { ...args, operationId: 'review-2' })
  expect(closed.isError, JSON.stringify(closed)).toBe(false)
  expect(closed.value).toMatchObject({ status: 'closed', duplicate: false })
  expect((await execute('send_message', { ...args, operationId: 'review-2' })).value).toMatchObject({ ...closed.value as object, duplicate: true })
  expect((await execute('inspect_worker', { assignmentId })).value).toMatchObject({
    acceptedCloseout: true, recentToolFailures: [{ tool: 'read', callEventSeq: expect.any(Number) as unknown, detail: expect.stringContaining('Source is unavailable') as unknown }], reportAttempts: [{ status: 'returned' }],
    progress: { resolved: ['Scope checked'], uncertain: ['Missing source'], nextCheck: 'Report the unresolved source', acceptedEvidence: false },
  })
  expect(JSON.stringify(prepared.assignment)).toBe(frozen)
  expect(root.session.events.filter(event => event.type === 'diagnostic/worker-report')).toHaveLength(0)
  expect(adapter.requests.filter(request => request.sessionId === child.id)).toHaveLength(3)
  expect(JSON.stringify(adapter.requests[1]!.messages)).toContain(args.message)
  const persisted = await ctx.sessionPersistence.load(child.id)
  expect(persisted.events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text === args.message))).toHaveLength(1)
  expect((await execute('update_progress', { resolved: [], uncertain: [], nextCheck: 'Reopen' }, child)).isError).toBe(true)
})

it('reconciles a lost guidance acknowledgement using the durable child inbox', async () => {
  const { ctx, root, child, execute, assignmentId } = await setup()
  const args = { operationId: 'lost-ack', assignmentId, childSessionId: child.id, message: 'Finish the guard check, then report.' }
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let fail = true
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (...args) => {
    if (fail && root.session.events.some(event => event.type === 'diagnostic/guidance' && event.data.status === 'queued')) { fail = false; throw new Error('Lost persistence acknowledgement') }
    return flush(...args)
  })
  expect((await execute('send_message', args)).isError).toBe(true)
  spy.mockRestore()
  const repeated = await execute('send_message', args)
  expect(repeated.value).toMatchObject({ status: 'queued', duplicate: true })
  expect(child.session.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.content.some(block => block.type === 'text' && block.text === args.message)))).toHaveLength(1)
})

it.each(['before-checkpoint', 'during-flush'])('preserves a report arriving %s', async (timing) => {
  const { ctx, root, child, execute, assignmentId } = await setup()
  const afterSeq = root.session.seq - 1
  const publish = () => root.session.append('diagnostic/worker-report', {
    runId: 'run-1', assignmentId, childSessionId: child.id, reportRef: 'retained-report', sha256: 'a'.repeat(64),
    closeoutRef: { producerSessionId: child.id, executorCorrelationId: 'receipt', callEventSeq: 1, resultEventSeq: 2 },
    packet: { summary: 'Accepted packet', report: {}, candidateRefs: [], evidenceRefs: [], unresolvedQuestions: [], crossAreaDependencies: [] },
  })
  let report: ReturnType<typeof publish>
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = timing === 'during-flush' ? vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (...args) => {
    spy?.mockRestore(); report = publish(); return flush(...args)
  }) : undefined
  const waiting = execute('wait_for_workers', { afterSeq, timeoutMs: 5 })
  if (timing === 'before-checkpoint') report = publish()
  const value = (await waiting).value as { reason: string; nextSeq: number }
  const result = value.reason === 'checkpoint' ? await execute('wait_for_workers', { afterSeq: value.nextSeq, timeoutMs: 5 }) : { value }
  expect(result.value).toMatchObject({ reason: 'updates', updates: [{ kind: 'report_available', seq: report!.seq, reportRef: 'retained-report' }] })
})

it('does not widen an existing workflow admission when the executor upgrades', async () => {
  const { ctx, root, execute, input, assignmentId } = await setup(false)
  expect(ctx.subagents.diagnostics.capability()?.diagnosticSupervisionVersions).toEqual([1])
  expect((await execute('wait_for_workers', { afterSeq: root.session.seq, timeoutMs: 1 })).isError).toBe(true)
  expect((await execute('inspect_worker', { assignmentId })).isError).toBe(true)
  expect((await execute('send_message', { operationId: 'no', assignmentId, childSessionId: 'no', message: 'no' })).isError).toBe(true)
  await expect(ctx.subagents.diagnostics.admit({ ...input, diagnosticSupervisionVersion: 1 })).rejects.toThrow()
  expect(root.session.events.findLast(event => event.type === 'diagnostic/run-state')?.data.admission).toEqual(input)
})


it('accepted closeout racing intent persistence prevents enqueue', async () => {
  const { ctx, root, child, execute, assignmentId, closed, signal } = await setup()
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (...args) => {
    if (root.session.events.some(event => event.type === 'diagnostic/guidance')) closed.add(child.id)
    return flush(...args)
  })
  const result = await execute('send_message', { operationId: 'race', assignmentId, childSessionId: child.id, message: 'Finish' })
  spy.mockRestore()
  expect(result.value).toMatchObject({ status: 'closed' })
  expect(signal.aborted).toBe(false)
  expect(child.session.events.some(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step')).toBe(false)
})

it('retains cancelled guidance without replaying it', async () => {
  const { child, execute, assignmentId } = await setup()
  const args = { operationId: 'cancelled', assignmentId, childSessionId: child.id, message: 'Finish' }
  expect((await execute('send_message', args)).value).toMatchObject({ status: 'queued' })
  child.cancel({ kind: 'user' })
  expect((await execute('send_message', args)).value).toMatchObject({ status: 'cancelled', duplicate: true })
})

it('advertises complete inspection and distinguishes source failures from report attempts', async () => {
  const { ctx, root, child, execute, release, assignmentId } = await setup()
  const schema = ctx.tools.schemas(root).find(tool => tool.name === 'inspect_worker')!.parameters
  expect(schema.required).toEqual(['assignmentId'])
  release.resolve(true); await child.whenIdle()
  const inspection = (await execute('inspect_worker', { assignmentId })).value as { recentToolFailures: unknown[]; reportAttempts: unknown[] }
  expect(inspection.recentToolFailures).toHaveLength(1)
  expect(inspection.reportAttempts).toHaveLength(1)
  expect(inspection.reportAttempts[0]).toMatchObject({ tool: 'closeout_json', acceptance: 'unknown', attribution: null })
})

it('anchors reviews to worker launch, subtracts inspection time and replays lost replies exactly', async () => {
  const { ctx, root, execute } = await setup(true, true)
  const anchorMs = root.session.events.find(event => event.type === 'diagnostic/reservation' && event.data.childSessionId)!.time
  let now = anchorMs + 30000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const review = { scheduleId: 'periodic', operationId: 'first', intervalMs: 30000 }
  const request = { afterSeq: root.session.seq - 1, review }
  const first = await execute('wait_for_workers', request)
  expect(first.value).toMatchObject({ reason: 'checkpoint', nextSeq: request.afterSeq,
    review: { anchorMs, deadlineMs: anchorMs + 30000, nextReview: 1 } })
  now += 7000
  expect((await execute('wait_for_workers', request)).value).toEqual(first.value)
  expect((await execute('wait_for_workers', { ...request, review: { ...review, intervalMs: 31000 } })).isError).toBe(true)
  const schedule = root.session.events.findLast(event => event.type === 'diagnostic/review-schedule')!
  expect(schedule.data).toMatchObject({ anchorMs, nextReview: 2 })
  // Time spent inspecting is deducted from the next anchored tick, never a new full interval.
  now = anchorMs + 60000
  const second = await execute('wait_for_workers', { ...request, review: { ...review, operationId: 'second' } })
  expect(second.value).toMatchObject({ reason: 'checkpoint', review: { deadlineMs: anchorMs + 60000 } })
  const persisted = await ctx.sessionPersistence.inspect(root.id)
  expect(persisted.events.filter(event => event.type === 'diagnostic/review-result')).toHaveLength(2)
  vi.restoreAllMocks()
})

it('returns pending without cancelling an in-flight source call, then captures and forks its complete context', async () => {
  const { ctx, root, child, release, signal, input, setBinding, adapter, script, assignmentId } = await setup()
  const pending = await ctx.subagents.diagnostics.checkpointTree(root.id, 5)
  expect(pending).toMatchObject({ state: 'pending' })
  expect(signal.aborted).toBe(false)
  const capturing = ctx.subagents.diagnostics.checkpointTree(root.id, 1000)
  await new Promise(resolve => setTimeout(resolve, 10))
  release.resolve(true)
  const snapshot = await capturing
  if ('state' in snapshot) throw new Error(snapshot.reason)
  const worker = snapshot.sessions.find(session => session.header.id === child.id)!
  expect(worker.position.openTurn).toBe(true)
  expect(worker.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
  await child.whenIdle()
  await new Promise(resolve => setTimeout(resolve, 25))
  const originalHold = await root.holdCheckpoint!(new AbortController().signal)
  try {
    const unchanged = JSON.stringify(root.session.events)
    const fork = { checkpointId: 'fixture-checkpoint', rootSessionId: 'fork-root', runId: 'fork-run', executorBindingId: 'fork-binding',
      sessionIds: { [root.id]: 'fork-root', [child.id]: 'fork-child' },
      changes: { guidance: { [child.id]: 'The source is missing. Record it as unresolved and report.' }, toolDescriptions: {}, acceptCurrentToolDefinitions: false } }
    setBinding({ executorBindingId: fork.executorBindingId, bindingEpoch: 1, rootSessionId: fork.rootSessionId, runId: fork.runId,
      comparisonDigest: input.comparisonDigest, sourceRefs: input.sourceRefs, state: 'active', diagnosticWorkflowVersion: 1, diagnosticSupervisionVersion: 1 })
    await ctx.subagents.diagnostics.restoreTree(snapshot, fork)
    expect(JSON.stringify(root.session.events)).toBe(unchanged)
    const restored = ctx.agents.get(SessionId('fork-child'))!, forkRoot = ctx.agents.get(SessionId('fork-root'))!
    expect(restored.session.header.parentSession).toBe(forkRoot.id)
    expect(restored.session.events.filter(event => event.type === 'tool/result')).toEqual(worker.events.filter(event => event.type === 'tool/result'))
    expect(forkRoot.session.events.findLast(event => event.type === 'diagnostic/run-state')!.data.admission.maxChildren).toBe(input.maxChildren)
    expect(forkRoot.session.events.filter(event => event.type === 'diagnostic/request')).toHaveLength(snapshot.sessions[0]!.events.filter(event => event.type === 'diagnostic/request').length)
    expect(await ctx.subagents.listChildren(forkRoot.id)).toMatchObject([{ kind: 'child', id: restored.id }])
    expect(restored.status).toBe('idle')
    script.push(toolCallResponse('fork-closeout', 'closeout_json', { report: {} }), toolCallResponse('root-closeout', 'closeout_json', { report: {} }))
    ctx.subagents.diagnostics.startTree(forkRoot.id)
    await restored.whenIdle(); await forkRoot.whenIdle()
    const continued = adapter.requests.find(request => request.sessionId === restored.id)!
    expect(JSON.stringify(continued.messages)).toContain('Source is unavailable')
    expect(JSON.stringify(continued.messages)).toContain(fork.changes.guidance[child.id])
    expect(restored.session.events.filter(event => event.type === 'tool/call' && event.data.name === 'read')).toHaveLength(1)
    expect(restored.session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(forkRoot.session.events.findLast(event => event.type === 'diagnostic/reservation')!.data.assignmentId).toBe(assignmentId)
    expect(JSON.stringify(root.session.events)).toBe(unchanged)
  } finally {
    originalHold.release()
  }
})

it('captures all active workers after their source calls settle, without changing frozen limits', async () => {
  const { ctx, root, execute, release, signal } = await setup(true, false, 2)
  const second = await execute('dispatch_workers', { requests: [{ requestKey: 'second', name: 'Second guard', role: 'discovery', objective: 'Inspect another guard', namespace: '', responsibility: '', paths: [] }] })
  expect(second.isError).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 10))
  const capturing = ctx.subagents.diagnostics.checkpointTree(root.id, 1000)
  await new Promise(resolve => setTimeout(resolve, 10))
  release.resolve(true)
  const snapshot = await capturing
  if ('state' in snapshot) throw new Error(snapshot.reason)
  expect(snapshot.sessions).toHaveLength(3)
  expect(snapshot.sessions.filter(session => session.position.openTurn)).toHaveLength(2)
  expect(snapshot.sessions.filter(session => session.header.origin === 'subagent').every(session => session.events.some(event => event.type === 'tool/result'))).toBe(true)
  expect(signal.aborted).toBe(false)
  await Promise.all(ctx.agents.list().map(agent => agent.whenIdle()))
})

class PagingSpillStore extends SpillStore {
  saves: string[] = []
  async saveText(input: SaveTextSpill) {
    this.saves.push(input.content)
    return { locator: SpillLocator('/inaccessible/report.txt'), bytes: Buffer.byteLength(input.content), retrievalHint: 'Read the backend spill file.' }
  }
}

it.each(['below', 'at', 'above', 'large', 'escaped', 'unicode', 'lines'] as const)('delivers intact report pages through the formatter: %s', async (shape) => {
  const { ctx, root, input, prepared, execute } = await setup(false)
  await ctx.plugin(PagingSpillStore)
  await ctx.plugin(SpillPolicy, { maxInlineBytes: 50_000 })
  const reportRef = `${root.id}:00000000-0000-4000-8000-000000000000`
  const packet = { summary: '', report: {}, candidateRefs: [], evidenceRefs: ['accepted-read:1'], unresolvedQuestions: [], crossAreaDependencies: [] }
  const empty = { reportRef, offset: 0, nextOffset: null, text: diagnosticCanonicalJson(packet), sha256: 'a'.repeat(64) }
  const remaining = 50_000 - Buffer.byteLength(JSON.stringify(empty))
  packet.summary = shape === 'below' ? 'x'.repeat(remaining - 1)
    : shape === 'at' ? 'x'.repeat(remaining)
      : shape === 'above' ? 'x'.repeat(remaining + 1)
        : shape === 'escaped' ? '\"\\\t\u0000'.repeat(30_000)
          : shape === 'unicode' ? '漢é😀'.repeat(40_000)
            : shape === 'lines' ? 'line\n'.repeat(40_000) : 'x'.repeat(220_000)
  const sha256 = diagnosticRecordDigest(packet)
  root.session.append('diagnostic/worker-report', { runId: input.runId, assignmentId: prepared.assignment.assignmentId,
    childSessionId: 'worker', closeoutRef: { producerSessionId: 'worker', executorCorrelationId: 'accepted', callEventSeq: 1, resultEventSeq: 2 },
    packet, reportRef, sha256 })
  const before = diagnosticCanonicalJson(packet)
  let offset: number | null = 0, text = '', pages = 0
  while (offset !== null) {
    const args = { reportRef, offset }
    const result = await execute('read_worker_report', args)
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    const rendered = result.content[0]!
    expect(rendered.type).toBe('text')
    if (rendered.type !== 'text') throw new Error('Expected report text')
    expect(Buffer.byteLength(rendered.text)).toBeLessThanOrEqual(50_000)
    const page = JSON.parse(rendered.text) as { offset: number; nextOffset: number | null; text: string; reportRef: string; sha256: string }
    expect(page).toMatchObject({ reportRef, sha256, offset })
    expect(page.text).toBe(before.slice(offset, offset + page.text.length))
    expect(page.nextOffset).toBe(offset + page.text.length === before.length ? null : offset + page.text.length)
    expect((await execute('read_worker_report', args)).content).toEqual(result.content)
    text += page.text; offset = page.nextOffset; pages++
    expect(pages).toBeLessThan(100)
  }
  expect(text).toBe(before)
  const end = await execute('read_worker_report', { reportRef, offset: text.length })
  expect(end.value).toEqual({ reportRef, offset: text.length, nextOffset: null, text: '', sha256 })
  expect(end.content).toEqual([{ type: 'text', text: JSON.stringify(end.value) }])
  expect(diagnosticRecordDigest(packet)).toBe(sha256)
  expect((ctx.spillStore as PagingSpillStore).saves).toEqual([])
  expect(pages).toBeGreaterThanOrEqual(['below', 'at'].includes(shape) ? 1 : 2)
  if (['below', 'at'].includes(shape)) expect(pages).toBe(1)
  if (shape === 'below') {
    const foreign = await ctx.agents.create({ sessionId: SessionId('other-run') })
    const publication = root.session.events.find(event => event.type === 'diagnostic/worker-report')!
    if (publication.type !== 'diagnostic/worker-report') throw new Error('Missing fixture publication')
    const foreignRef = reportRef.replace(root.id, foreign.agent.id)
    foreign.agent.session.append('diagnostic/worker-report', { ...publication.data, reportRef: foreignRef })
    const denied = await execute('read_worker_report', { reportRef: foreignRef })
    expect(denied.isError).toBe(true)
    expect(JSON.parse((denied.content[0] as { text: string }).text).error.code).toBe('authority_denied')
    expect((await execute('read_worker_report', { reportRef }, foreign.agent)).isError).toBe(true)
  }
})

it.each(['legacy', 'supervision', 'review'] as const)('pages worker updates including the %s envelope through the formatter', async (mode) => {
  const { ctx, root, child, assignmentId, execute } = await setup(mode !== 'legacy', mode === 'review')
  await ctx.plugin(PagingSpillStore)
  await ctx.plugin(SpillPolicy, { maxInlineBytes: 1500 })
  let afterSeq = root.session.seq - 1
  const expected = Array.from({ length: 40 }, (_, i) => root.session.append('diagnostic/missing-report', {
    reminderId: 'reminder-' + i + 'x'.repeat(100), sessionId: child.id, assignmentId, turn: i + 1,
  }).seq)
  const seen: number[] = []
  let pages = 0
  while (seen.length < expected.length) {
    const result = await execute('wait_for_workers', { afterSeq, ...(mode === 'review' ? { review: { scheduleId: 'paging', operationId: 'page-' + pages, intervalMs: 1800000 } } : {}) })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    const page = JSON.parse((result.content[0] as { text: string }).text) as { updates: { seq: number; kind: string }[]; nextSeq: number }
    seen.push(...page.updates.filter(update => update.kind === 'missing_report').map(update => update.seq))
    expect(page.nextSeq).toBeGreaterThan(afterSeq)
    afterSeq = page.nextSeq
    expect(++pages).toBeLessThan(50)
  }
  expect(seen).toEqual(expected)
  expect(pages).toBeGreaterThan(1)
  expect((ctx.spillStore as PagingSpillStore).saves).toEqual([])
})
