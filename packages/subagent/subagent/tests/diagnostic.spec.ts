/** Published caller fixtures through core validation and real session admission. */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Report from '../../tool-subagent-report/src/index.ts'
import Subagents, { DIAGNOSTIC_POLICY, diagnosticCanonicalJson, diagnosticRecordDigest, parseDiagnosticAdmission, parseDiagnosticAssignment, diagnosticInstructions } from '../src/index.ts'
import type { DiagnosticAdmission, DiagnosticBinding } from '../src/index.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/diagnostic-assignments.json', import.meta.url), 'utf8')) as Record<string, unknown>
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const admission = () => parseDiagnosticAdmission(structuredClone(fixtures['admit-run']), Date.parse('2030-01-01T00:00:00Z'))

describe('diagnostic admission', () => {
  it('validates the published resolved assignment without changing authored settings', () => {
    const input = admission()
    expect(input.coordinatorAssignment.roleSettings).toEqual({ outputLimit: 8192, maxReportSizeKiB: 1280 })
    expect(diagnosticInstructions(input.coordinatorAssignment).systemPrompt?.base).toEqual({ mode: 'replace', text: input.coordinatorAssignment.instructionSnapshot.baseContent })
    expect(() => parseDiagnosticAssignment({ ...input.coordinatorAssignment, objective: 'changed' })).toThrow('digest mismatch')
  })

  it('matches Python ASCII encoding and rejects ambiguous numbers', () => {
    expect(diagnosticCanonicalJson({ '\u{10000}': '\u007f', '\ue000': 'é', a: '\n' })).toBe('{"a":"\\n","\\ue000":"\\u00e9","\\ud800\\udc00":"\\u007f"}')
    expect(() => diagnosticCanonicalJson({ cap: 1.5 })).toThrow('safe integers')
    expect(() => diagnosticCanonicalJson({ cap: Infinity })).toThrow('lossless JSON')
  })

  it('rejects child delegation even after a caller recomputes its digest', () => {
    const prepared = fixtures['prepare-discovery'] as { assignment: unknown }
    const assignment = parseDiagnosticAssignment(prepared.assignment)
    assignment.authority.mayDelegate = true
    assignment.digest = diagnosticRecordDigest(assignment, true)
    expect(() => parseDiagnosticAssignment(assignment)).toThrow('cannot delegate')
  })

  it('persists admission before acknowledgement and refuses changed retry or direct policy mutation', async () => {
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-')); directories.push(directory)
    await ctx.plugin(JsonlPersistence, { root: directory })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    const input: DiagnosticAdmission = admission()
    let binding: DiagnosticBinding = {
      executorBindingId: input.executorBindingId, bindingEpoch: input.bindingEpoch, runId: input.runId,
      rootSessionId: input.rootSessionId, comparisonDigest: input.comparisonDigest, sourceRefs: input.sourceRefs,
      state: 'awaiting-admission',
    }
    ctx.subagents.diagnostics.registerExecutor({
      binding: () => binding,
      admit: async () => { binding = { ...binding, state: 'active' } },
      install: () => () => {}, cancel: async () => {}, quiescent: () => true,
    })
    const handle = await ctx.agents.create({ sessionId: SessionId(input.rootSessionId), meta: { sessionPolicy: DIAGNOSTIC_POLICY } })
    handle.agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    handle.agent.session.append('approval/policy', { policy: 'never' })
    const result = await ctx.subagents.diagnostics.admit(input)
    expect(result.duplicate).toBe(false)
    const persisted = await ctx.sessionPersistence.load(handle.agent.id)
    expect(persisted.events.some(event => event.type === 'diagnostic/run-state')).toBe(true)
    expect((await ctx.subagents.diagnostics.admit(input)).duplicate).toBe(true)
    await expect(ctx.subagents.diagnostics.admit({ ...input, maxChildren: 3 })).rejects.toThrow('conflicts')
    expect(() => handle.agent.session.configureInstructions({ version: 1 })).toThrow('immutable')
    expect(() => handle.agent.session.append('sandbox/mode', { mode: 'read-only' })).toThrow('immutable')
    expect(() => handle.agent.session.append('approval/policy', { policy: 'ask' })).toThrow('immutable')
    await expect(ctx.subagents.startContinuable({ provider: 'spawn', label: 'raw', signal: new AbortController().signal, request: { parent: handle.agent, prompt: [{ type: 'text', text: 'raw' }] } })).rejects.toThrow('prepared assignment')
  })
  it('runs a prepared assignment as a native child with fixed instructions and model', async () => {
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-native-')); directories.push(directory)
    await ctx.plugin(JsonlPersistence, { root: directory })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Report)
    const input = admission()
    const prepared = structuredClone(fixtures['prepare-discovery']) as { runId: string; rootSessionId: string; idempotencyKey: string; assignment: typeof input.coordinatorAssignment }
    const adapter = new MockAdapter([
      toolCallResponse('delegate', 'subagent', { assignmentId: prepared.assignment.assignmentId, run_in_background: true }),
      textResponse('Source review complete.'), textResponse('Child accepted.'), textResponse('Child settled.'), textResponse('Continuation complete.'), textResponse('Root done.'),
    ])
    adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model,
      context: { contextWindow: input.coordinatorAssignment.commonModel.contextWindow },
      contextOptions: { defaultContextWindow: input.coordinatorAssignment.commonModel.contextWindow,
        contextWindows: [{ contextWindow: input.coordinatorAssignment.commonModel.contextWindow, available: true }] },
    })
    ctx.llm.registerAdapter([input.coordinatorAssignment.commonModel.provider], adapter)
    let binding: DiagnosticBinding = { executorBindingId: input.executorBindingId, bindingEpoch: input.bindingEpoch, runId: input.runId,
      rootSessionId: input.rootSessionId, comparisonDigest: input.comparisonDigest, sourceRefs: input.sourceRefs, state: 'awaiting-admission' }
    ctx.subagents.diagnostics.registerExecutor({ binding: () => binding, admit: async () => { binding = { ...binding, state: 'active' } },
      install: () => () => {}, cancel: async () => {}, quiescent: () => true })
    const { agent } = await ctx.agents.create({ sessionId: SessionId(input.rootSessionId), meta: { sessionPolicy: DIAGNOSTIC_POLICY } })
    await ctx.subagents.diagnostics.admit(input)
    await ctx.subagents.diagnostics.prepare(prepared)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the prepared assignment.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const records = agent.session.events.filter(event => event.type === 'diagnostic/reservation')
    expect(records.at(-1)?.data.state, JSON.stringify(agent.session.events.filter(event => event.type === 'turn/end' || event.type === 'tool/result'))).toBe('accepted')
    const childId = records.at(-1)!.data.childSessionId!
    const child = ctx.agents.get(SessionId(childId))!
    await child?.whenIdle()
    const persisted = await ctx.sessionPersistence.load(SessionId(childId))
    expect(persisted.meta.sessionPolicy).toBe(DIAGNOSTIC_POLICY)
    expect(persisted.events.find(event => event.type === 'session/instructions')?.data.instructions).toEqual(diagnosticInstructions(prepared.assignment))
    expect(adapter.requests.some(request => request.sessionId === childId)).toBe(true)
    expect(adapter.requests.find(request => request.sessionId === childId)?.tools?.some(tool => tool.name === 'report')).not.toBe(true)
    const forbidden = await ctx.tools.execute({ name: 'report', callId: CallId('forbidden-report'), agent: child,
      arguments: { output: 'must use accepted closeout' }, signal: new AbortController().signal })
    expect(forbidden.isError).toBe(true)
    const followup = structuredClone(prepared)
    followup.idempotencyKey = 'followup-assignment'
    followup.assignment.assignmentId = 'followup-assignment'
    followup.assignment.digest = diagnosticRecordDigest(followup.assignment, true)
    await ctx.subagents.diagnostics.prepare(followup)
    const continued = await ctx.tools.execute({ name: 'send_message', callId: CallId('continue'), agent,
      arguments: { childSessionId: childId, assignmentId: followup.assignment.assignmentId }, signal: new AbortController().signal })
    expect(continued.isError, JSON.stringify(continued)).toBe(false)
    const duplicate = await ctx.tools.execute({ name: 'send_message', callId: CallId('duplicate'), agent,
      arguments: { childSessionId: childId, assignmentId: followup.assignment.assignmentId }, signal: new AbortController().signal })
    expect(duplicate.isError).toBe(false)
    expect(duplicate.value).toMatchObject({ childSessionId: childId, duplicate: true })
    await ctx.agents.get(SessionId(childId))?.whenIdle()

    for (const request of adapter.requests) {
      expect(request.provider).toBe(input.coordinatorAssignment.commonModel.provider)
      expect(request.model).toBe(input.coordinatorAssignment.commonModel.model)
      expect(request.tools?.some(tool => ['bash', 'write', 'executor_command'].includes(tool.name))).not.toBe(true)
    }
  })

})
