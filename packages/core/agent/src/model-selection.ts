/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** One scalar serving option declared by a model load mode. */
export type ModelServingOption = string | number | boolean

/** The user's output preference; `auto` delegates to the model's configured default. */
export type OutputLimit = 'auto' | number

/** Complete provider, model, and optional context/reasoning selection for one live Agent. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-advertised context tier, or the model default when absent. */
  contextWindow?: number
  /** Permit an advertised host-constrained context tier for best-effort dispatch. */
  bestTryContext?: boolean
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
  /** Catalog-declared worker load mode, or its default when absent. */
  mode?: string
  /** Catalog-declared serving options for the selected load mode. */
  options?: Readonly<Record<string, ModelServingOption>>
  /** Per-request output preference, independent of the selected context tier. */
  outputLimit?: OutputLimit
  /** Backend worker identity observed when this selection was accepted. */
  workerConfigIdentity?: string
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request routing.
 * Prompt assembly snapshots the selected model before delegating, then applies
 * its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns Disposer for both scoped waterfall listeners.
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const hardMaxTokens = (agentCtx as Context & { agent?: { options: { maxTokens?: number } } }).agent?.options.maxTokens
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = selection.assembled
      if (selected === undefined) return resolved
      const {
        reasoningEffort: _inheritedEffort,
        contextWindow: _inheritedContextWindow,
        bestTryContext: _inheritedBestTryContext,
        mode: _inheritedMode,
        options: _inheritedOptions,
        workerConfigIdentity: _inheritedWorkerConfigIdentity,
        maxTokens: _inheritedMaxTokens,
        ...withoutInheritedSelection
      } = resolved
      return {
        ...withoutInheritedSelection,
        provider: selected.provider,
        model: selected.model,
        ...selected.contextWindow === undefined
          ? {}
          : { contextWindow: selected.contextWindow },
        ...selected.bestTryContext === undefined
          ? {}
          : { bestTryContext: selected.bestTryContext },
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
        ...selected.mode === undefined ? {} : { mode: selected.mode },
        ...selected.options === undefined ? {} : { options: selected.options },
        ...typeof selected.outputLimit === 'number'
          ? { maxTokens: selected.outputLimit }
          : hardMaxTokens === undefined ? {} : { maxTokens: hardMaxTokens },
        ...selected.workerConfigIdentity === undefined ? {} : { workerConfigIdentity: selected.workerConfigIdentity },
      }
    },
  )
  return () => {
    disposeAssembly()
    disposeRequest()
  }
}
