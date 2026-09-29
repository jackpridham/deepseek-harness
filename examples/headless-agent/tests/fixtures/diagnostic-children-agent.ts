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
import Subagents, { DIAGNOSTIC_POLICY, parseDiagnosticAdmission, diagnosticRecordDigest } from '@deepseek-ai/dsh-subagent'
import type { DiagnosticBinding, DiagnosticAssignment } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'

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
  input.maxOutputTokens = 2_000_000
  for (const assignment of [input.coordinatorAssignment, prepared.assignment]) {
    assignment.roleSettings.outputLimit = 65536
    assignment.budget.maxOutputTokens = 1_000_000
    assignment.digest = diagnosticRecordDigest(assignment, true)
  }
  let rootRequests = 0
  const response = (options: import('@deepseek-ai/dsh-llm').GenerateOptions) => {
    if (options.purpose === 'compaction') {
      process.stdout.write(`${JSON.stringify({ type: 'diagnostic-summary', contextWindow: options.contextWindow, maxTokens: options.maxTokens })}\n`)
      return textResponse('Candidate C1; pending gap G1; evidence reference read:159. Unvalidated.')
    }
    if (options.sessionId !== input.rootSessionId) return textResponse('Child accepted.')
    if (rootRequests++ > 0) return textResponse('Child accepted.')
    return toolCallResponse('delegate', 'subagent', { assignmentId: prepared.assignment.assignmentId, run_in_background: true })
  }
  class FixtureAdapter extends MockAdapter {
    override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions) {
      if (options.sessionId === input.rootSessionId && rootRequests > 0) {
        const child = ctx.get('agents')!.list().find(agent => agent.session.header.parentSession === input.rootSessionId)
        await child?.whenIdle()
      }
      yield* super.stream(options)
    }
  }
  const adapter = new FixtureAdapter(Array.from({ length: 8 }, () => response))
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
  }
  ctx.effect(() =>
    ctx.get('subagents')!.diagnostics.registerExecutor({
      binding: () => binding,
      admit: async () => {
        binding = { ...binding, state: 'active' }
      },
      install: (agent, assignment) => {
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
  await ctx.get('subagents')!.diagnostics.prepare(prepared)
  ctx.on('session/event', async (_session, event) => {
    if (event.type !== 'diagnostic/reservation' || event.data.state !== 'accepted' || !event.data.childSessionId) return
    const accepted = await ctx.get('subagents')!.renameChild(handle.agent, SessionId(event.data.childSessionId), input.runId,
      session => ctx.get('sessionTitle')!.rename(session, 'OWASP discovery child'))
    process.stdout.write(`${JSON.stringify({ type: 'child-title', title: accepted.title })}\n`)
  })
}
