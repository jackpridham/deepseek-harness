/**
 * Bounded summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, createUserMessage, BlockAssembler, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use one to three terse bullets per section, no prose paragraphs, and at most about 1000 words total. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Retry directive after the first summary reached its output cap. */
const CONCISE_COMPACTION_INSTRUCTION = [
  'Write a complete, terse engineering checkpoint for the conversation above.',
  'Output exactly these Markdown headings, in order. Put one to three short bullets under each; retain only goals, exact paths, identifiers, decisions, errors, constraints, current work, and next action. Use "(none)" when empty. Do not explain compaction or call tools.',
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
].join('\n')

/** Reserve framing and adapter accounting beyond the metered replay input. */
const SUMMARY_HEADROOM_MARGIN = 256

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/** Complete usable output from one summary stream, or `undefined` at its token cap. */
interface SummaryStreamResult {
  readonly summary: Array<Extract<ContentBlock, { type: 'text' }>>
  readonly rawOutput: ContentBlock[]
  readonly usage?: TokenUsage
}

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const inherited = configured === undefined ? latest : undefined
  const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
  const reasoningEffort = info.reasoning?.efforts.find(effort => effort.id === ReasoningEffortId('off'))?.id
    ?? info.reasoning?.efforts[0]?.id
  const selectedContextWindow = inherited?.contextWindow ?? info.loaded?.contextWindow
  const contextWindow = selectedContextWindow
    ?? info.context?.contextWindow
    ?? info.contextOptions?.defaultContextWindow
  const messagesFor = (instruction: string): Message[] => [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    }),
  ]
  const capFor = (requested: number, messages: readonly Message[]): number => {
    if (contextWindow === undefined) return info.maxTokens === undefined ? requested : Math.min(requested, info.maxTokens)
    const measurement = ctx.tokenMeter.measure(agent.session)
    const replayTokens = messages.reduce((total, message) => total + ctx.tokenMeter.estimateMessage(message), 0)
    const headerTokens = Math.max(0, measurement.totalTokens - measurement.surfaceTokens)
    const headroom = contextWindow - headerTokens - replayTokens - SUMMARY_HEADROOM_MARGIN
    return Math.min(requested, info.maxTokens ?? requested, headroom)
  }
  const optionsFor = (messages: Message[], maxTokens: number): GenerateOptions => ({
    provider: target.provider,
    model: target.model,
    ...selectedContextWindow === undefined ? {} : { contextWindow: selectedContextWindow },
    ...inherited?.bestTryContext === undefined ? {} : { bestTryContext: inherited.bestTryContext },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    ...inherited?.mode === undefined
      ? info.loaded?.mode === undefined ? {} : { mode: info.loaded.mode }
      : { mode: inherited.mode },
    ...inherited?.options === undefined
      ? info.loaded?.options === undefined ? {} : { options: info.loaded.options }
      : { options: inherited.options },
    ...info.loaded?.identity === undefined ? {} : { workerConfigIdentity: info.loaded.identity },
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  })
  const firstMessages = messagesFor(COMPACTION_INSTRUCTION)
  const firstCap = capFor(config.maxTokens, firstMessages)
  if (firstCap <= 0) throw noHeadroomError()
  const first = await streamSummary(ctx, optionsFor(firstMessages, firstCap))
  if (first !== undefined) return {
    ...first,
    llmStreamCall: true,
    provider: target.provider,
    model: target.model,
    maxTokens: firstCap,
  }

  const retryMessages = messagesFor(CONCISE_COMPACTION_INSTRUCTION)
  const retryRequested = contextWindow !== undefined && info.maxTokens !== undefined
    ? Math.max(firstCap, config.maxTokens * 2)
    : firstCap
  const retryCap = capFor(retryRequested, retryMessages)
  if (retryCap <= 0) throw noHeadroomError()
  signal?.throwIfAborted()
  const retry = await streamSummary(ctx, optionsFor(retryMessages, retryCap))
  if (retry === undefined) throw truncatedError(retryCap)
  return {
    ...retry,
    provider: target.provider,
    model: target.model,
    maxTokens: retryCap,
  }
}

/** Stream one complete text-only summary, returning `undefined` only for a token-cap finish. */
async function streamSummary(ctx: Context, options: GenerateOptions): Promise<SummaryStreamResult | undefined> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  if (assembler.finish.kind === 'max-tokens') return undefined
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Surface a terminal checkpoint truncation without accepting its partial output. */
function truncatedError(maxTokens: number): LlmError {
  return new LlmError(
    `compaction summary truncated after two attempts at token cap ${maxTokens}; no checkpoint was committed. Use a larger supported context or a dedicated summarizer.`,
    'COMPACTION_SUMMARY_TRUNCATED',
  )
}

/** Report that the replay input leaves no usable generation reserve. */
function noHeadroomError(): LlmError {
  return new LlmError(
    'compaction summary has no output headroom; no checkpoint was committed. Use a larger supported context or a dedicated summarizer.',
    'COMPACTION_SUMMARY_TRUNCATED',
  )
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': return undefined
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
