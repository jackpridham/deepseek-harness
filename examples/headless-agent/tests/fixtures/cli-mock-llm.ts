import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')
const longContext = process.env.DSH_CLI_MOCK_LONG_CONTEXT === '1'
const compactionCase = process.env.DSH_CLI_MOCK_COMPACTION

/** Keyless headless-agent adapter: one real bash call followed by a final answer. */
class CliMockAdapter extends LlmAdapter {
  private summaryAttempts = 0
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      ...longContext || compactionCase !== undefined ? {
        context: { contextWindow: 32768 },
        defaultMaxTokens: compactionCase === undefined ? 4096 : 8192,
        maxTokens: 8192,
      } : {},
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (compactionCase !== undefined && options.purpose === 'compaction') {
      this.summaryAttempts++
      if (compactionCase.startsWith('empty-')) {
        if (this.summaryAttempts > 2) throw new Error('unbounded empty-summary retry')
        if (this.summaryAttempts === 1 || compactionCase === 'empty-fail') {
          yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: 0, text: 'private unusable output' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
      }
      const text = compactionCase === 'empty-recover' ? 'Keep the completed tool result.' : 'Expanded checkpoint. '.repeat(250)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = JSON.stringify({ command: compactionCase === undefined ? 'printf CLI_TOOL_ROUND_TRIP' : "printf '%24000s' x", description: 'Prove the CLI tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('cli-smoke-call'), name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('cli-smoke-call'), name: 'bash', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: (compactionCase === 'fits' || compactionCase?.startsWith('empty-')) ? 24_000 : compactionCase === 'full' ? 28_000 : longContext ? 20_000 : 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `CLI tool round trip complete: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: longContext ? 20_100 : 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm']

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new CliMockAdapter())
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 && !longContext && compactionCase === undefined ? { ...config, reasoningEffort: OFF } : config
  })
}
