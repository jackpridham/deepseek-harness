/** Keyless Loader composition of the diagnostic policy and native child owner. */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Titles from '@deepseek-ai/dsh-session-title'
import Projections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Subagents, { DIAGNOSTIC_POLICY, parseDiagnosticAdmission } from '@deepseek-ai/dsh-subagent'
import type { DiagnosticBinding, DiagnosticAssignment } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
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
  const adapter = new MockAdapter([
    toolCallResponse('delegate', 'subagent', {
      assignmentId: prepared.assignment.assignmentId,
      run_in_background: true,
    }),
    textResponse('Source review complete.'),
    textResponse('Child accepted.'),
    textResponse('Child settled.'),
  ])
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
      install: () => () => {},
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
