/** Published caller fixtures through core validation and real session admission. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { MockAdapter, textResponse, toolCallResponse, maxTokensResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { CallId, createUserMessage, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
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
  it('accepts caller-selected child counts up to the wire integer limit', () => {
    const input = admission()
    for (const count of [1, 9, Number.MAX_SAFE_INTEGER]) {
      expect(parseDiagnosticAdmission({ ...input, maxChildren: count, maxConcurrentChildren: Math.min(count, 6) }, Date.parse('2030-01-01')))
        .toMatchObject({ maxChildren: count, maxConcurrentChildren: Math.min(count, 6) })
    }
    for (const count of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => parseDiagnosticAdmission({ ...input, maxChildren: count, maxConcurrentChildren: count }, Date.parse('2030-01-01'))).toThrow()
    expect(() => parseDiagnosticAdmission({ ...input, maxChildren: 2, maxConcurrentChildren: 3 }, Date.parse('2030-01-01'))).toThrow('reserves')
  })
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

  it.each([undefined, 2])('persists admission and enforces configured concurrency %s', async (configuredConcurrency) => {
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-')); directories.push(directory)
    await ctx.plugin(JsonlPersistence, { root: directory })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(BasicCompaction, { sessionPolicies: [DIAGNOSTIC_POLICY], thresholdRatio: 0.65 })
    await ctx.plugin(SessionProjections)
    const config = configuredConcurrency === undefined ? undefined : { diagnosticMaxConcurrentChildren: configuredConcurrency }
    await ctx.plugin(Subagents, config)
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
    const limit = configuredConcurrency ?? 6
    expect(ctx.subagents.diagnostics.capability()).toMatchObject({ maxChildren: Number.MAX_SAFE_INTEGER, maxConcurrentChildren: limit })
    await expect(ctx.subagents.diagnostics.admit({ ...input, maxChildren: 9, maxConcurrentChildren: limit + 1 })).rejects.toThrow(`host limit ${limit}`)
    const result = await ctx.subagents.diagnostics.admit(input)
    expect(Object.keys(result).sort()).toEqual(['runId', 'rootSessionId', 'state', 'admissionDigest', 'bindingEpoch', 'duplicate'].sort())
    expect(result.duplicate).toBe(false)
    const persisted = await ctx.sessionPersistence.load(handle.agent.id)
    expect(persisted.events.some(event => event.type === 'diagnostic/run-state')).toBe(true)
    expect(await ctx.subagents.diagnostics.admit(input)).toEqual({ ...result, duplicate: true })
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
    await ctx.plugin(BasicCompaction, { sessionPolicies: [DIAGNOSTIC_POLICY], thresholdRatio: 0.65 })
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
    expect(await ctx.subagents.renameChild(agent, SessionId(childId), input.runId, session => session.id)).toBe(childId)
    await expect(ctx.subagents.renameChild(agent, SessionId(childId), 'wrong', () => undefined)).rejects.toThrow('admitted parent run')
    await expect(ctx.subagents.renameChild(agent, SessionId('absent'), input.runId, () => undefined)).rejects.toThrow('unavailable')
    await child?.whenIdle()
    await ctx.subagents.diagnostics.refresh(agent.id)
    const settledSeq = agent.session.seq
    for (let i = 0; i < 100; i++) await ctx.subagents.diagnostics.refresh(agent.id)
    expect(agent.session.seq).toBe(settledSeq)
    expect(agent.session.events.findLast(event => event.type === 'diagnostic/child-state')?.data).toMatchObject({ state: 'settled', quiescent: true })
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

  it.each(['coordinator', 'discovery', 'validation', 'automatic', 'irreducible', 'truncated', 'summary-failure', 'unavailable', 'cancelled', 'small-output', 'medium-output', 'small-context'] as const)('diagnostic output admission: %s', async (scenario) => {
    const outputLimit = scenario === 'small-output' ? 4096 : scenario === 'medium-output' ? 32768 : scenario === 'small-context' ? 8192 : 65536
    const contextWindow = scenario === 'small-context' ? 32768 : 262144
    const role = scenario === 'discovery' || scenario === 'validation' ? scenario : 'coordinator'
    const ctx = new Context(); contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const directory = mkdtempSync(join(tmpdir(), 'dsh-diagnostic-budget-')); directories.push(directory)
    await ctx.plugin(JsonlPersistence, { root: directory, compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SessionProjections)
    if (scenario !== 'unavailable') await ctx.plugin(BasicCompaction, { sessionPolicies: [DIAGNOSTIC_POLICY], auto: scenario === 'automatic', thresholdRatio: 0.65 })
    await ctx.plugin(Subagents)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    const input = admission()
    input.maxOutputTokens = 2_000_000
    input.coordinatorAssignment.roleSettings.outputLimit = outputLimit
    input.coordinatorAssignment.budget.maxOutputTokens = 1_000_000
    input.coordinatorAssignment.commonModel.contextWindow = contextWindow
    input.coordinatorAssignment.digest = diagnosticRecordDigest(input.coordinatorAssignment, true)
    const prepared = structuredClone(fixtures[role === 'validation' ? 'prepare-validation' : 'prepare-discovery']) as { runId: string; rootSessionId: string; idempotencyKey: string; assignment: typeof input.coordinatorAssignment }
    prepared.assignment.roleSettings.outputLimit = outputLimit
    prepared.assignment.budget.maxOutputTokens = 1_000_000
    prepared.assignment.commonModel.contextWindow = contextWindow
    prepared.assignment.digest = diagnosticRecordDigest(prepared.assignment, true)
    const adapter = new MockAdapter(scenario === 'cancelled' ? ['hang'] : scenario === 'truncated' ? [maxTokensResponse('partial'), maxTokensResponse('partial again')]
      : scenario === 'summary-failure' ? [() => { throw new Error('summary offline') }]
        : [textResponse('Candidate C1; unresolved gap G1; evidence read:159. Not independent validation.'), textResponse('Continue review.')])
    adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow },
      contextOptions: { defaultContextWindow: contextWindow, contextWindows: [{ contextWindow, available: true }] } })
    ctx.llm.registerAdapter([input.coordinatorAssignment.commonModel.provider], adapter)
    let target: import('@deepseek-ai/dsh-agent').Agent | undefined
    let originalSeqs: number[] = []
    let binding: DiagnosticBinding = { executorBindingId: input.executorBindingId, bindingEpoch: input.bindingEpoch,
      runId: input.runId, rootSessionId: input.rootSessionId, comparisonDigest: input.comparisonDigest, sourceRefs: input.sourceRefs, state: 'awaiting-admission' }
    ctx.subagents.diagnostics.registerExecutor({ binding: () => binding, admit: async () => { binding = { ...binding, state: 'active' } },
      cancel: async () => {}, quiescent: () => true,
      install: (agent, assignment) => {
        if (assignment.role !== role || agent.session.events.some(event => event.type === 'request/header')) return () => {}
        target = agent
        const snapshot = assignment.instructionSnapshot
        agent.session.append('request/header', { reason: 'initial', header: {
          config: { ...assignment.commonModel, maxTokens: outputLimit },
          system: [snapshot.baseContent, ...snapshot.expertise.map(asset => asset.content)].filter(Boolean).join('\n\n'),
        } })
        if (scenario === 'irreducible') {
          agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(800000) }] }), { surfaceOp: 'append' })
          originalSeqs = [...agent.session.surface.nodes]
          return () => {}
        }
        const historySize = scenario === 'automatic' ? 90000 : Math.floor((contextWindow - outputLimit) / 2) + 1000
        for (let i = 0; i < 8; i++) {
          const callId = CallId(`history-${i}`)
          const name = i % 2 ? 'closeout_json' : 'read'
          const argumentsJson = i % 2 ? JSON.stringify({ report: { findings: 'x'.repeat(historySize) } }) : '{}'
          agent.session.append('step/start', { turn: 0, step: i + 1 })
          agent.session.append('assistant/message', { turn: 0, step: i + 1,
            message: createMessage({ role: 'assistant', source: { kind: 'model', provider: assignment.commonModel.provider, model: assignment.commonModel.model },
              content: [{ type: 'tool-call', id: callId, name, arguments: argumentsJson }] }) }, { surfaceOp: 'append' })
          agent.session.append('tool/call', { turn: 0, step: i + 1, callId, name, arguments: argumentsJson })
          agent.session.append('tool/result', { turn: 0, step: i + 1,
            message: createToolResultMessage({ callId, isError: Boolean(i % 2), content: [{ type: 'text', text: i % 2 ? 'Rejected report: gap G1 unresolved.' : 'Evidence read:159 candidate C1. ' + 'x'.repeat(historySize) }] }) }, { surfaceOp: 'append' })
          agent.session.append('step/end', { turn: 0, step: i + 1 })
        }
        originalSeqs = [...agent.session.surface.nodes]
        expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(scenario === 'automatic' ? contextWindow * 0.65 : contextWindow - outputLimit - 256)
        return () => {}
      } })
    let handle = await ctx.agents.create({ sessionId: SessionId(input.rootSessionId), meta: { sessionPolicy: DIAGNOSTIC_POLICY } })
    if (scenario === 'unavailable') {
      await expect(ctx.subagents.diagnostics.admit(input)).rejects.toThrow('require the host compaction service')
      expect(adapter.requests).toHaveLength(0)
      return
    }
    await ctx.subagents.diagnostics.admit(input)
    if (role === 'coordinator') {
      await ctx.sessions.flush(handle.agent.session)
      await handle.dispose()
      handle = await ctx.agents.resume({ resumeSessionId: SessionId(input.rootSessionId) })
      target = handle.agent
      target.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    } else {
      await ctx.subagents.diagnostics.prepare(prepared)
      const started = await ctx.tools.execute({ name: 'subagent', callId: CallId('start'), agent: handle.agent,
        arguments: { assignmentId: prepared.assignment.assignmentId, run_in_background: true }, signal: new AbortController().signal })
      expect(started.isError, JSON.stringify(started)).toBe(false)
    }
    expect(target).toBeDefined()
    if (scenario === 'cancelled') {
      await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
      target!.cancel({ kind: 'user' })
    }
    await target!.whenIdle()
    const events = target!.session.events
    if (scenario === 'cancelled') {
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.purpose).toBe('compaction')
      expect(target!.session.surface.replaceGeneration).toBe(0)
      expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).not.toBe('completed')
      return
    }
    if (['irreducible', 'truncated', 'summary-failure'].includes(scenario)) {
      const outcome = events.findLast(event => event.type === 'turn/end')?.data.reason
      expect(outcome).toMatchObject({ kind: 'error', error: { code: scenario === 'irreducible' ? 'OUTPUT_BUDGET_EXCEEDED' : scenario === 'truncated' ? 'COMPACTION_SUMMARY_TRUNCATED' : 'UNKNOWN' } })
      expect(adapter.requests.every(request => request.purpose === 'compaction')).toBe(true)
      expect(target!.session.surface.replaceGeneration).toBe(0)
      expect(originalSeqs.every(seq => events[seq] !== undefined)).toBe(true)
      return
    }
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason).toEqual({ kind: 'completed' })
    expect(events.some(event => event.type === 'compaction/start')).toBe(true)
    expect(events.some(event => event.type === 'compaction/end')).toBe(true)
    expect(target!.session.surface.replaceGeneration).toBeGreaterThan(0)
    expect(originalSeqs.every(seq => events[seq] !== undefined)).toBe(true)
    expect(adapter.requests.map(request => request.purpose)).toEqual(['compaction', undefined])
    expect(adapter.requests.map(request => request.maxTokens)).toEqual([Math.min(8192, outputLimit), outputLimit])
    for (const request of adapter.requests) {
      expect(request.provider).toBe(input.coordinatorAssignment.commonModel.provider)
      expect(request.model).toBe(input.coordinatorAssignment.commonModel.model)
      expect(request.contextWindow).toBe(contextWindow)
      expect(request.tools?.some(tool => ['bash', 'read_file'].includes(tool.name))).not.toBe(true)
    }
    const budget = events.findLast(event => event.type === 'output/budget')!
    expect(budget.data.effective).toBe(outputLimit)
    expect(budget.data.inputTokens + budget.data.effective + budget.data.safetyMargin).toBeLessThanOrEqual(contextWindow)
    const charges = handle.agent.session.events.filter(event => event.type === 'diagnostic/request').filter(event => event.data.state === 'reserved')
    expect(charges.map(event => event.data.outputTokens)).toEqual([Math.min(8192, outputLimit), outputLimit])
    expect(handle.agent.session.events.findLast(event => event.type === 'diagnostic/run-state')?.data.state).not.toBe('completed')
    if (scenario === 'discovery' || scenario === 'validation') {
      const childId = target!.id
      await ctx.sessions.flush(target!.session)
      await handle.dispose()
      handle = await ctx.agents.resume({ resumeSessionId: SessionId(input.rootSessionId) })
      const followup = structuredClone(prepared)
      followup.idempotencyKey = 'restored-followup'
      followup.assignment.assignmentId = 'restored-followup'
      followup.assignment.digest = diagnosticRecordDigest(followup.assignment, true)
      await ctx.subagents.diagnostics.prepare(followup)
      const continued = await ctx.tools.execute({ name: 'send_message', callId: CallId('restored'), agent: handle.agent,
        arguments: { childSessionId: childId, assignmentId: followup.assignment.assignmentId }, signal: new AbortController().signal })
      expect(continued.isError, JSON.stringify(continued)).toBe(false)
      const restored = ctx.agents.get(childId)!
      await restored.whenIdle()
      expect(restored).not.toBe(target)
      expect(restored.session.surface.replaceGeneration).toBeGreaterThan(0)
      expect(restored.session.events.findLast(event => event.type === 'output/budget')?.data.effective).toBe(outputLimit)
      expect(adapter.requests.at(-1)?.maxTokens).toBe(outputLimit)
      expect(handle.agent.session.events.findLast(event => event.type === 'diagnostic/run-state')?.data.state).not.toBe('completed')
    }
  })

})
