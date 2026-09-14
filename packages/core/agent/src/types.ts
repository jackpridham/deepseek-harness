/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import type { ModelSelection } from './model-selection.ts'

/** Actual request-stream milestones that a host may persist for its session UI. */
export interface LlmRequestLifecycle {
  observe(event: {
    sessionId?: string
    provider: string
    model: string
    contextWindow?: number
    mode?: string
    options?: Readonly<Record<string, string | number | boolean>>
    workerConfigIdentity?: string
    turn?: number
    step?: number
    /** Local requests use requesting/executing; managed backends supply their actual scheduler phase. */
    phase: string
    outcome?: string
    operationId?: string
    reason?: { code?: string; message?: string }
    swap?: unknown
  }): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional host-owned durable view of actual LLM request milestones. */
    llmRequestLifecycle: LlmRequestLifecycle
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A session-local model preference, persisted before its first request. */
    'model/selection': { selection: ModelSelection }
    /** A correlated managed-worker lifecycle observation for this session. */
    'model/lifecycle': {
      operationId?: string
      turn?: number
      step?: number
      phase: string
      outcome: string
      reason?: { code?: string; message?: string }
      swap?: unknown
    }
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}
