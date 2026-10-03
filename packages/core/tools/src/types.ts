/**
 * Durable Tool event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-tools/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Payload recorded when one nested Code Mode Tool dispatch starts. */
export interface CodeDispatchStartEventData {
  rootCallId: CallId
  parentCallId: CallId
  subCallId: CallId
  name: string
  arguments: unknown
}

/** Payload recorded when one nested Code Mode Tool dispatch settles. */
export interface CodeDispatchEventData extends CodeDispatchStartEventData {
  isError: boolean
  content: ContentBlock[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One sub-dispatch STARTING inside a `run_code` program: the parent
     * `run_code` call id, the deterministic sub-call id (`<parent>:code:<n>`,
     * numbered in submission order), and the tool `name` with its
     * JSON-normalized `arguments` — the exact value dispatched, normalized
     * BEFORE dispatch, so this append can never fail on payload shape.
     * Appended when the scheduler actually starts the call (not at
     * submission), so a start means the tool body pipeline was entered; a
     * call abandoned in the queue logs nothing. Log-only: `deriveMessages()`
     * ignores it; UIs use it for live per-sub-call running state and pair it
     * with `tool/code-dispatch` by `subCallId` (timing = the two events'
     * `time` fields).
     */
    'tool/code-dispatch-start': CodeDispatchStartEventData
    /**
     * One bridged sub-dispatch SETTLING: the pairing ids (matching the
     * `tool/code-dispatch-start` with the same `subCallId`), the tool `name`
     * with the same JSON-normalized `arguments`, and the sub-call's complete
     * model-facing outcome in `tool/result`'s own vocabulary
     * (`content` + `isError`), so UIs render a sub-call through the exact
     * code path that renders a native call. Every started sub-call settles
     * with exactly one of these (abort included: the aborted pipeline result
     * is an `isError` outcome).
     * Log-only: `deriveMessages()` ignores it, so sub-calls never re-enter
     * model context; persistence and UIs get every call. Appended inside the
     * parent `run_code`'s execution (the bridge drains in-flight dispatches
     * before returning), so its execution-enclosure relation holds by
     * construction.
     */
    'tool/code-dispatch': CodeDispatchEventData
  }
}

/** An unguessable canonical-result reference meaningful only in its owning session. */
export type ResultReference = Branded<'ResultReference'>
/** Immutable origin of a successful canonical value; excludes arguments and credentials. */
export interface ResultProvenance { tool: string; callId: string; root: 'structuredContent' | 'value' }
/** Literal JSON Pointer source and destination for exact value transfer. */
export interface ResultBinding { result: string; source: string; target: string }
/** Audit identity for one nested result-transfer invocation; values remain private. */
export interface ResultTransferEventData {
  callId: string
  targetCallId: string
  tool: string
  bindings: ResultBinding[]
  phase: 'started' | 'finished'
  isError?: boolean
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable canonical locator committed before its model-facing notice. */
    'tool/result-reference': ResultProvenance & { reference: string }
    /** Target identity and reference provenance, never a replay instruction. */
    'tool/result-transfer': ResultTransferEventData
  }
}
