/** Keyless Loader composition of the diagnostic policy and native child owner. */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Titles from '@deepseek-ai/dsh-session-title'
import Projections from '@deepseek-ai/dsh-session-projection'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Subagents, { DIAGNOSTIC_POLICY, parseDiagnosticAdmission, diagnosticRecordDigest, diagnosticCanonicalJson } from '@deepseek-ai/dsh-subagent'
import type { DiagnosticBinding, DiagnosticAssignment } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { SpillStore, SpillLocator } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

class FixtureSpill extends SpillStore {
  async saveText(input: SaveTextSpill) {
    process.stdout.write(JSON.stringify({ type: 'unexpected-spill' }) + '\n')
    return { locator: SpillLocator('/unavailable/report.txt'), bytes: Buffer.byteLength(input.content), retrievalHint: 'Read backend spill.' }
  }
}

/** Loader fixture name. */
export const name = 'diagnostic-children-snapshot'
/** Assemble an admitted root without a network provider. @param ctx - Loader-owned scope. */
export async function apply(ctx: Context): Promise<void> {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Persistence, { root: './.sessions', compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Titles, { fallbackMaxWords: 8, fallbackMaxBytes: 80, maxTitleBytes: 80 })
  await ctx.plugin(Projections)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(BasicCompaction, { sessionPolicies: [DIAGNOSTIC_POLICY], thresholdRatio: 0.65 })
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const fixtures = JSON.parse(
    readFileSync(
      new URL('../../../../packages/subagent/subagent/tests/fixtures/diagnostic-assignments.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>
  const input = parseDiagnosticAdmission(fixtures['admit-run'], Date.parse('2030-01-01'))
  const prepared = fixtures['prepare-discovery'] as {
    runId: string
    rootSessionId: string
    idempotencyKey: string
    assignment: DiagnosticAssignment
  }
  const workflowMode = process.env.DSH_TEST_DIAGNOSTIC_WORKFLOW
  const inspection = workflowMode === 'inspection'
  const supervision = workflowMode === 'supervision' || workflowMode === 'review' || inspection
  const review = workflowMode === 'review'
  const recovery = workflowMode === 'recovery'
  const paging = workflowMode === 'paging'
  const workflow = workflowMode === '1' || workflowMode === 'prose' || supervision || recovery || paging
  const reading = Promise.withResolvers<boolean>(), release = Promise.withResolvers<boolean>()
  let childRequests = 0
  const closed = new Set<string>()
  if (workflow) {
    input.diagnosticWorkflowVersion = 1
    if (recovery) input.diagnosticCloseoutRecoveryVersion = 1
    input.coordinatorAssignment.authority.tools = ['read', 'glob', 'grep', 'closeout_json', 'dispatch_workers', 'wait_for_workers', 'read_worker_report']
  }
  if (supervision) {
    input.diagnosticSupervisionVersion = 1
    if (review) input.diagnosticReviewVersion = 1
    input.coordinatorAssignment.authority.tools.push('inspect_worker', 'send_message', 'update_progress')
    prepared.assignment.authority.tools.push('update_progress')
  }
  if (inspection) prepared.assignment.objective = 'Investigate the full assigned scope. '.repeat(3000)
  input.maxOutputTokens = 2_000_000
  for (const assignment of [input.coordinatorAssignment, prepared.assignment]) {
    assignment.roleSettings.outputLimit = 65536
    assignment.budget.maxOutputTokens = 1_000_000
    assignment.digest = diagnosticRecordDigest(assignment, true)
  }
  const reportRef = `${input.rootSessionId}:00000000-0000-4000-8000-000000000000`
  const packet = { summary: '漢😀\"\\\n'.repeat(150), report: { confidence: 0.95 }, candidateRefs: [], evidenceRefs: ['accepted-read:1'], unresolvedQuestions: [], crossAreaDependencies: [] }
  let reconstructed = '', pageCount = 0
  if (paging || inspection) {
    await ctx.plugin(FixtureSpill)
    await ctx.plugin(SpillPolicy, { maxInlineBytes: 1500 })
  }
  let rootRequests = 0
  const response = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => {
    if (options.purpose === 'compaction') {
      process.stdout.write(`${JSON.stringify({ type: 'diagnostic-summary', contextWindow: options.contextWindow, maxTokens: options.maxTokens })}\n`)
      return textResponse('Candidate C1; pending gap G1; evidence reference read:159. Unvalidated.')
    }
    if (paging) {
      if (rootRequests++ === 0) return toolCallResponse('page-0', 'read_worker_report', { reportRef })
      const toolResult = options.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result')
      if (toolResult?.type !== 'tool-result' || toolResult.content[0]?.type !== 'text') throw new Error('Expected model-visible report page')
      const rendered = toolResult.content[0].text
      const page = JSON.parse(rendered) as { text: string; offset: number; nextOffset: number | null; sha256: string }
      if (page.offset !== reconstructed.length || page.sha256 !== diagnosticRecordDigest(packet) || Buffer.byteLength(rendered) > 1500)
        throw new Error('Invalid model-visible page')
      reconstructed += page.text; pageCount++
      if (page.nextOffset !== null) return toolCallResponse('page-' + pageCount, 'read_worker_report', { reportRef, offset: page.nextOffset })
      process.stdout.write(JSON.stringify({ type: 'report-paging', multiplePages: pageCount > 1, exact: reconstructed === diagnosticCanonicalJson(packet), intact: true }) + '\n')
      return toolCallResponse('finish', 'closeout_json', { report: { summary: 'Complete report retrieved.' } })
    }
    if (supervision) {
      if (options.sessionId !== input.rootSessionId) {
        if (childRequests++ === 0) return toolCallResponse('progress', 'update_progress', { resolved: ['Assignment scoped'], uncertain: ['Guard source'], nextCheck: 'Finish the guard check' })
        if (childRequests === 2) return toolCallResponse('source', 'read', {})
        return toolCallResponse('finish', 'closeout_json', { report: { summary: 'Guard checked; report submitted.' } })
      }
      const child = ctx.get('agents')!.list().find(agent => agent.session.header.parentSession === input.rootSessionId)
      const identity = { assignmentId: prepared.assignment.assignmentId, childSessionId: child?.id }
      if (review && rootRequests === 0) process.stdout.write(`${JSON.stringify({ type: 'supervision-schema', inspectRequired: (options.tools!.find(tool => tool.name === 'inspect_worker')!.parameters as { required: string[] }).required })}\n`)
      switch (rootRequests++) {
        case 0: return toolCallResponse('dispatch', 'dispatch_workers', { requests: [{ requestKey: 'discovery', name: 'Discovery', role: 'discovery', responsibility: '', namespace: '', paths: [], objective: 'Examine admitted source' }] })
        case 1: return toolCallResponse('checkpoint', 'wait_for_workers', { afterSeq: 0, ...(review ? { review: { scheduleId: 'periodic', operationId: 'review-1', intervalMs: 1 } } : { timeoutMs: 5 }) })
        case 2: return toolCallResponse('inspect', 'inspect_worker', { assignmentId: identity.assignmentId })
        case 3: {
          if (inspection) {
            const result = options.messages.flatMap(message => message.content).findLast(block => block.type === 'tool-result')
            if (result?.type !== 'tool-result' || result.content[0]?.type !== 'text') throw new Error('Missing model-visible inspection')
            const text = result.content[0].text
            const value = JSON.parse(text) as { scope: { objective: string } }
            if (value.scope.objective !== prepared.assignment.objective) throw new Error('Inspection scope was truncated')
            process.stdout.write(JSON.stringify({ type: 'complete-inspection', bytesAboveOldCap: Buffer.byteLength(text) > 50000, exact: true }) + '\n')
          }
          return toolCallResponse('guide', 'send_message', { ...identity, operationId: 'review-1', message: 'Finish the guard check, then report.' })
        }
        default: return toolCallResponse('finish', 'closeout_json', { report: { summary: 'Retained diagnostic closeout.' } })
      }
    }
    if (workflow) {
      if (recovery && options.sessionId !== input.rootSessionId && childRequests++ === 0)
        return textResponse('Investigation finished: {"summary":"Evidence retained in context"}')
      if (recovery && options.sessionId === input.rootSessionId && rootRequests >= 1 && rootRequests <= 2) {
        rootRequests++
        return textResponse('All investigations have finished; no durable coordinator report submitted yet.')
      }
      if (workflowMode === 'prose' && options.sessionId !== input.rootSessionId)
        return textResponse('Finished without submitting a report.')
      if (workflowMode === 'prose' && rootRequests === 1) {
        rootRequests++
        return toolCallResponse('wait', 'wait_for_workers', { afterSeq: 0 })
      }
      if (options.sessionId !== input.rootSessionId || rootRequests++ > 0)
        return toolCallResponse('finish', 'closeout_json', { report: { summary: 'Retained diagnostic closeout.' } })
      return toolCallResponse('dispatch', 'dispatch_workers', { requests: [{ requestKey: 'discovery', name: 'Discovery', role: 'discovery', responsibility: '', namespace: '', paths: [], objective: 'Examine admitted source' }] })
    }
    if (options.sessionId !== input.rootSessionId) return textResponse('Child accepted.')
    if (rootRequests++ > 0) return textResponse('Child accepted.')
    return toolCallResponse('delegate', 'subagent', { assignmentId: prepared.assignment.assignmentId, run_in_background: true })
  }
  class FixtureAdapter extends MockAdapter {
    override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions) {
      if (supervision && options.sessionId === input.rootSessionId && rootRequests === 1) await reading.promise
      if (supervision && options.sessionId === input.rootSessionId && rootRequests === 4) release.resolve(true)
      if (options.sessionId === input.rootSessionId && rootRequests > 0 && (!supervision || rootRequests === 4)) {
        const child = ctx.get('agents')!.list().find(agent => agent.session.header.parentSession === input.rootSessionId)
        await child?.whenIdle()
      }
      yield* super.stream(options)
    }
  }
  const adapter = new FixtureAdapter(Array.from({ length: 12 }, () => response))
  const contextWindow = input.coordinatorAssignment.commonModel.contextWindow
  adapter.resolveModel = async (provider, model) => ({
    provider,
    id: model,
    name: model,
    context: { contextWindow },
    contextOptions: { defaultContextWindow: contextWindow, contextWindows: [{ contextWindow, available: true }] },
  })
  ctx.effect(() => ctx.get('llm')!.registerAdapter([input.coordinatorAssignment.commonModel.provider], adapter))
  let binding: DiagnosticBinding = {
    executorBindingId: input.executorBindingId,
    bindingEpoch: 1,
    runId: input.runId,
    rootSessionId: input.rootSessionId,
    comparisonDigest: input.comparisonDigest,
    sourceRefs: input.sourceRefs,
    state: 'awaiting-admission',
    ...(workflow ? { diagnosticWorkflowVersion: 1 as const } : {}),
    ...(supervision ? { diagnosticSupervisionVersion: 1 as const } : {}),
    ...(review ? { diagnosticReviewVersion: 1 as const } : {}),
    ...(recovery ? { diagnosticCloseoutRecoveryVersion: 1 as const } : {}),
  }
  ctx.effect(() =>
    ctx.get('subagents')!.diagnostics.registerExecutor({
      binding: () => binding,
      ...(workflow ? {
        diagnosticWorkflowVersions: [1],
        diagnosticSupervisionVersions: [1],
        diagnosticReviewVersions: [1],
        diagnosticCloseoutRecoveryVersions: [1],
        prepareWorkers: async () => {
          await ctx.get('subagents')!.diagnostics.prepare(prepared)
          return { prepared: [{ requestKey: 'discovery', status: 'prepared', assignmentId: prepared.assignment.assignmentId }] }
        },
        awaitCloseout: async () => {},
        closed: (_root: SessionId, producer: SessionId) => closed.has(producer),
      } : {}),
      admit: async () => {
        binding = { ...binding, state: 'active' }
      },
      install: (agent, assignment) => {
        if (supervision && assignment.role !== 'coordinator') agent.ctx.effect(() => agent.ctx.tools.register({
          name: 'read', description: 'Read the admitted source.', parameters: { type: 'object' },
          output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async () => { reading.resolve(true); await release.promise; return { text: 'Guard source' } },
        }))
        if (workflow) return agent.ctx.tools.register({ name: 'closeout_json', description: 'Submit the assignment report.', parameters: { type: 'object', properties: { report: { type: 'object' } }, required: ['report'] },
          output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args, execution) => { closed.add(agent.id); process.stdout.write(`${JSON.stringify({ type: 'accepted-closeout', role: assignment.role })}\n`); execution.concludeTurn(); return args },
        })
        if (assignment.role === 'discovery' && !agent.session.events.some(event => event.type === 'request/header')) {
          const snapshot = assignment.instructionSnapshot
          agent.session.append('request/header', { reason: 'initial', header: {
            config: { ...assignment.commonModel, maxTokens: 65536 },
            system: [snapshot.baseContent, ...snapshot.expertise.map(asset => asset.content)].filter(Boolean).join('\n\n'),
          } })
          for (let i = 0; i < 8; i++) agent.session.append('user/message', createUserMessage({ source: { kind: 'user' },
            content: [{ type: 'text', text: `Candidate C1 evidence read:159 gap G1 ${i}: ` + 'x'.repeat(100000) }] }), { surfaceOp: 'append' })
        }
        return () => {}
      },
      cancel: async () => {},
      quiescent: () => true,
    }),
  )
  const handle = await ctx
    .get('agents')!
    .create({ sessionId: SessionId(input.rootSessionId), meta: { sessionPolicy: DIAGNOSTIC_POLICY } })
  ctx.effect(() => () => handle.dispose())
  await ctx.get('subagents')!.diagnostics.admit(input)
  if (paging) handle.agent.session.append('diagnostic/worker-report', {
    runId: input.runId, assignmentId: prepared.assignment.assignmentId, childSessionId: 'retained-worker',
    closeoutRef: { producerSessionId: 'retained-worker', executorCorrelationId: 'accepted-closeout', callEventSeq: 1, resultEventSeq: 2 },
    reportRef, packet, sha256: diagnosticRecordDigest(packet),
  })
  const capacity = ctx.get('subagents')!.diagnostics.capability()
  process.stdout.write(`${JSON.stringify({ type: 'diagnostic-worker-capacity', maxChildren: capacity?.maxChildren, maxConcurrentChildren: capacity?.maxConcurrentChildren })}\n`)
  if (!workflow) await ctx.get('subagents')!.diagnostics.prepare(prepared)
  ctx.on('session/event', async (_session, event) => {
    if (supervision && _session.id === input.rootSessionId && event.type === 'tool/result') {
      const block = event.data.message.content.find(block => block.type === 'tool-result')
      const content = block?.content?.find(block => block.type === 'text')
      const value = (content ? JSON.parse(content.text) : {}) as {
        reason?: string
        nextSeq?: number
        review?: { due: boolean; nextReview: number }
        activeWorkers: unknown[]
        progress?: { resolved: string[]; acceptedEvidence: boolean }
        operationId?: string
        status?: string
        duplicate?: boolean
      }
      if (value.reason) process.stdout.write(`${JSON.stringify({ type: 'supervision-checkpoint', reason: value.reason, nextSeq: value.nextSeq, active: value.activeWorkers.length })}\n`)
      if (value.review) process.stdout.write(`${JSON.stringify({ type: 'anchored-review', due: value.review.due, nextReview: value.review.nextReview })}\n`)
      if (value.progress) process.stdout.write(`${JSON.stringify({ type: 'supervision-progress', resolved: value.progress.resolved, acceptedEvidence: value.progress.acceptedEvidence })}\n`)
      if (value.operationId) process.stdout.write(`${JSON.stringify({ type: 'supervision-guidance', status: value.status, duplicate: value.duplicate })}\n`)
    }
    if (event.type === 'diagnostic/closeout-recovery')
      process.stdout.write(`${JSON.stringify({ type: 'closeout-recovery', role: _session.id === input.rootSessionId ? 'coordinator' : 'worker', state: event.data.state, turn: event.data.turn })}\n`)
    if (event.type === 'diagnostic/child-state') {
      const data = event.data as { state: string; quiescent: boolean }
      process.stdout.write(`${JSON.stringify({ type: 'diagnostic-child-outcome', state: data.state, quiescent: data.quiescent })}\n`)
    }
    if (event.type !== 'diagnostic/reservation' || event.data.state !== 'accepted' || !event.data.childSessionId) return
    const accepted = await ctx.get('subagents')!.renameChild(handle.agent, SessionId(event.data.childSessionId), input.runId,
      session => ctx.get('sessionTitle')!.rename(session, 'OWASP discovery child'))
    process.stdout.write(`${JSON.stringify({ type: 'child-title', title: accepted.title })}\n`)
  })
}
