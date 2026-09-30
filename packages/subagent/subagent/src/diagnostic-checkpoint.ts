/** Full diagnostic history snapshots and explicit new-identity continuation metadata. */
import type { AgentCheckpointPosition, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ToolSchema, UserMessage } from '@deepseek-ai/dsh-llm'

/** One frozen session at a recoverable inference boundary. */
export interface DiagnosticTreeSession {
  header: SessionHeader
  events: SessionEvent[]
  position: AgentCheckpointPosition
  inbox: { nextStep: UserMessage[]; nextTurn: UserMessage[] }
  tools: ToolSchema[]
  options: AgentOptions
  terminal: boolean
}

/** A complete backend snapshot; caller receipt/journal sealing is a separate step. */
export interface DiagnosticTreeSnapshot {
  version: 1
  continuationVersion: 1
  rootSessionId: string
  capturedAt: number
  sessions: DiagnosticTreeSession[]
  executorState: import('@deepseek-ai/dsh-session').JsonValue
}

/** Explicit fork identities and continuation-only experiment; all limits stay frozen. */
export interface DiagnosticTreeFork {
  checkpointId: string
  rootSessionId: string
  runId: string
  executorBindingId: string
  sessionIds: Record<string, string>
  changes: {
    guidance: Record<string, string>
    toolDescriptions: Record<string, string>
    acceptCurrentToolDefinitions: boolean
  }
}
