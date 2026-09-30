/** Supervision uses native worker turns and durable inbox delivery. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Compaction from '@deepseek-ai/dsh-compaction-basic'
import Meter from '@deepseek-ai/dsh-token-meter'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import Subagents, { DIAGNOSTIC_POLICY, diagnosticRecordDigest, parseDiagnosticAdmission } from '../src/index.ts'
import type { DiagnosticBinding, DiagnosticAssignment } from '../src/index.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const dispose of cleanup.splice(0)) await dispose() })
async function setup(supervised = true) {
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
  input.diagnosticWorkflowVersion = 1
  input.coordinatorAssignment.authority.tools = ['read', 'glob', 'grep', 'closeout_json', 'dispatch_workers', 'wait_for_workers', 'read_worker_report']
  if (supervised) {
    input.diagnosticSupervisionVersion = 1
    input.coordinatorAssignment.authority.tools.push('inspect_worker', 'send_message', 'update_progress')
    prepared.assignment.authority.tools.push('update_progress')
  }
  for (const assignment of [input.coordinatorAssignment, prepared.assignment]) assignment.digest = diagnosticRecordDigest(assignment, true)
  const adapter = new MockAdapter([
    toolCallResponse('source', 'read', {}),
    ...(supervised ? [toolCallResponse('progress', 'update_progress', { resolved: ['Scope checked'], uncertain: ['Missing source'], nextCheck: 'Report the unresolved source' })] : []),
    toolCallResponse('closeout', 'closeout_json', { report: {} }),
  ])
  adapter.resolveModel = async (provider, model) => {
    const contextWindow = input.coordinatorAssignment.commonModel.contextWindow
    return { provider, id: model, name: model, context: { contextWindow },
      contextOptions: { defaultContextWindow: contextWindow, contextWindows: [{ contextWindow, available: true }] } }
  }
  ctx.llm.registerAdapter([input.coordinatorAssignment.commonModel.provider], adapter)
  let binding: DiagnosticBinding = { executorBindingId: input.executorBindingId, bindingEpoch: 1,
    runId: input.runId, rootSessionId: input.rootSessionId,
    comparisonDigest: input.comparisonDigest, sourceRefs: input.sourceRefs, state: 'awaiting-admission', diagnosticWorkflowVersion: 1,
    ...(supervised ? { diagnosticSupervisionVersion: 1 as const } : {}) }
  const closed = new Set<string>()
  ctx.subagents.diagnostics.registerExecutor({
    diagnosticWorkflowVersions: [1], diagnosticSupervisionVersions: [1], binding: () => binding,
    admit: async () => { binding = { ...binding, state: 'active' } },
    prepareWorkers: async () => { await ctx.subagents.diagnostics.prepare(prepared); return { prepared: [{ requestKey: 'worker', status: 'prepared', assignmentId: prepared.assignment.assignmentId }] } },
    awaitCloseout: async () => {}, closed: (_root, producer) => closed.has(producer),
    cancel: async () => {}, quiescent: () => true,
    install: (agent) => {
      const disposers = ['read', 'closeout_json'].map(name => agent.ctx.tools.register({ name, description: name, parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (_args, execution) => {
          if (name === 'read') { reading.resolve(execution.signal); await release.promise; throw new Error('Source is unavailable') }
          closed.add(agent.id); execution.concludeTurn(); return { accepted: true }
        },
      }))
      return () => { disposers.forEach((dispose) => { dispose() }) }
    },
  })
  const { agent: root } = await ctx.agents.create({ sessionId: SessionId(input.rootSessionId), meta: { sessionPolicy: DIAGNOSTIC_POLICY } })
  await ctx.subagents.diagnostics.admit(input)
  const execute = (name: string, args: object, agent = root) => ctx.tools.execute({ name, callId: CallId('test-' + name), agent, arguments: args, signal: new AbortController().signal })
  const dispatch = await execute('dispatch_workers', { requests: [{ requestKey: 'worker', name: 'Guard check', role: 'discovery', objective: 'Inspect source', namespace: '', responsibility: '', paths: [] }] })
  expect(dispatch.isError, JSON.stringify(dispatch)).toBe(false)
  const signal = await reading.promise
  const childId = root.session.events.findLast(event => event.type === 'diagnostic/reservation')!.data.childSessionId!
  const child = ctx.agents.get(SessionId(childId))!
  const assignmentId = prepared.assignment.assignmentId
  return { ctx, root, child, execute, release, signal, input, prepared, assignmentId, adapter, closed }
}

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
  expect((await execute('inspect_worker', { assignmentId, maxEvents: 1 })).value).toMatchObject({
    acceptedCloseout: true, recentToolFailures: [{ detail: expect.stringContaining('Source is unavailable') as unknown }], reportAttempts: [{ status: 'returned' }],
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
