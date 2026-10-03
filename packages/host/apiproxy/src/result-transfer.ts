/** Generic selection and exact argument transfer through the admitted tool runtime. */
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { resultStoreDirectory } from '@deepseek-ai/dsh-agent-presets'
import type { ResultTransferLimits } from '@deepseek-ai/dsh-agent-presets/types'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ResultProvenance, ResultTransferEventData } from '@deepseek-ai/dsh-tools'
import { ResultStore, resolveBindings } from './result-store.ts'

/** Model-visible operations admitted only by the result-transfer profile. */
export const RESULT_TRANSFER_TOOLS = ['call_with_result', 'result_select']

const pointer = z.string().max(2048)
const selection = z.object({ result: z.string().regex(/^r_[a-f0-9]{24}$/), source: pointer }).strict()
const binding = selection.extend({ target: pointer }).strict()
const invocation = z.object({
  tool: z.string().max(128), arguments: z.record(z.string(), z.json()), bindings: z.array(binding).min(1).max(32),
}).strict()

/**
 * Remove canonical values after the session is quiescent and before deleting its log.
 * @param sessionId - exact session selected by the existing purge lifecycle.
 */
export async function retireResultStore(sessionId: string): Promise<void> {
  await rm(resultStoreDirectory(sessionId), { recursive: true, force: true })
}

function invalid(message: string): never { throw new HarnessError(message, 'RESULT_TRANSFER_INVALID') }
function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args)
  if (!result.success) invalid('Invalid result transfer arguments')
  return result.data
}

/**
 * Install session-owned generic operations and awaited canonical capture.
 * @param ctx - unpublished session's tool context.
 * @param identity - digest of its immutable profile and trusted identity.
 * @param limits - immutable quota and retention settings.
 */
export async function mountResultTransfer(ctx: Context, identity: string, limits: ResultTransferLimits): Promise<void> {
  const agent = ctx.agent
  if (!agent) throw new Error('Result transfer requires a session agent')
  const scope = createHash('sha256').update(JSON.stringify([agent.session.id, agent.session.header.createdAt, identity])).digest('hex')
  const store = await ResultStore.open(resultStoreDirectory(agent.session.id), scope, limits)
  const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true })
  addFormats(ajv)
  const validators = new WeakMap<ToolDefinition, ReturnType<typeof ajv.compile>>()
  const targets = new WeakMap<ToolExecution, ResultProvenance>()
  const projections = new WeakMap<ToolExecution, ToolExecutionResult>()

  function resolve(args: unknown) {
    if (Buffer.byteLength(JSON.stringify(args)) > 262144) invalid('Result transfer arguments exceed 262144 bytes')
    const call = parse(invocation, args)
    if (RESULT_TRANSFER_TOOLS.includes(call.tool) || call.tool === 'run_code') invalid('Recursive or executable result transfer is not allowed')
    const target = ctx.tools.get(call.tool, agent)
    if (!target) invalid('Target tool is not admitted in this session')
    const resolved = resolveBindings(store, call.arguments, call.bindings)
    let validate = validators.get(target)
    if (!validate) {
      try { validate = ajv.compile(target.parameters) }
      catch { invalid('Target schema cannot be validated for result transfer') }
      validators.set(target, validate)
    }
    if (!validate(resolved)) invalid('Resolved arguments do not satisfy the target tool schema')
    return { call, target, resolved }
  }

  ctx.tools.register({
    name: 'result_select',
    description: 'Inspect a captured successful result by JSON Pointer. Empty source selects the root. Arrays use zero-based indices; ~1 escapes / and ~0 escapes ~. Use the same result and source in call_with_result to transfer the exact value without copying it.',
    parameters: { ...z.toJSONSchema(selection) },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute(args) {
      const { result, source } = parse(selection, args)
      const value = store.select(result, source)
      const selected = { result, source, value, truncated: false }
      if (Buffer.byteLength(JSON.stringify(selected)) <= 4096) return Promise.resolve(selected)
      const summary = { result, source, truncated: true, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, bytes: Buffer.byteLength(JSON.stringify(value)) }
      if (Buffer.byteLength(JSON.stringify(summary)) > 4096) invalid('Selection pointer exceeds the output budget')
      return Promise.resolve(summary)
    },
  })
  ctx.tools.register({
    name: 'call_with_result',
    description: 'Copy exact JSON values from captured results into arguments, then call an admitted tool. No source tools are rerun. Bindings use JSON Pointers; target parent containers must exist, object members must be absent, and array destinations must be null placeholders. A transfer failure calls no target. Never automatically repeat a call whose outcome is uncertain.',
    parameters: { ...z.toJSONSchema(invocation) },
    output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe(args) {
      const { target, resolved } = resolve(args)
      return target.isConcurrencySafe?.(resolved) === true
    },
    async execute(args, exec) {
      const { call, resolved } = resolve(args)
      const targetCallId = CallId(`${exec.callId}:result`)
      const audit: ResultTransferEventData = { callId: exec.callId, targetCallId, tool: call.tool, bindings: call.bindings, phase: 'started' }
      agent.session.append('tool/result-transfer', audit)
      // A crash after this commit leaves an unresolved invocation, never a replay queue.
      await ctx.sessions.flush(agent.session)
      const result = await ctx.tools.execute({ callId: targetCallId, rootCallId: exec.rootCallId, parent: exec.token,
        name: call.tool, arguments: resolved, agent, signal: exec.signal })
      agent.session.append('tool/result-transfer', { ...audit, phase: 'finished', isError: result.isError })
      for (const context of result.additionalContexts ?? []) exec.deferContext(context)
      if (result.isError) throw new HarnessError(`${result.error.message} If execution started, the outcome may be uncertain; do not automatically replay mutations.`, result.error.info?.code ?? 'RESULT_TARGET_FAILED')
      if (result.concludesTurn) exec.concludeTurn()
      targets.set(exec, { tool: call.tool, callId: targetCallId, root: call.tool.startsWith('mcp__') ? 'structuredContent' : 'value' })
      projections.set(exec, result)
      return result.value
    },
    finalizeContent(exec, result) {
      const target = projections.get(exec)
      return target && !target.isError && !result.isError && isDeepStrictEqual(target.value, result.value)
        && isDeepStrictEqual(result.content, [{ type: 'text', text: JSON.stringify(result.value) }]) ? target.content : undefined
    },
  })
  ctx.on('tools/commit-content', async (exec, result, next) => {
    const content = await next()
    if (result.isError || exec.signal.aborted || exec.name === 'result_select') return content
    const provenance = targets.get(exec) ?? { tool: exec.name, callId: exec.callId, root: exec.name.startsWith('mcp__') ? 'structuredContent' as const : 'value' as const }
    let value = result.value
    if (provenance.root === 'structuredContent') {
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'structuredContent')) {
        return [...content, { type: 'text', text: 'Result reference unavailable: this tool returned no canonical structuredContent.' }]
      }
      value = value.structuredContent as JsonValue
    }
    let reference: string
    try { reference = await store.capture(value, provenance) }
    catch {
      // The tool has already completed: storage failure cannot turn it into a retryable tool failure.
      return [...content, { type: 'text', text: 'Result reference unavailable: canonical storage failed or its quota was exceeded. The tool has completed; do not repeat it to repair storage.' }]
    }
    agent.session.append('tool/result-reference', { ...provenance, reference })
    const notice: ContentBlock = { type: 'text', text: `Result reference: ${reference}; JSON Pointer root: ${provenance.root}. Use call_with_result for exact argument transfer.` }
    return [...content, notice]
  })
}
