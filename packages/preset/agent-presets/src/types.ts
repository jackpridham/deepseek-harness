/** Client-safe event declarations owned by the agent-preset domain. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Immutable assistant content. Version 2 adds a trusted, self-contained ESM tool module. */
export type AgentProfileDefinition = {
  id: string
  version: string
  systemPrompt: string
} & ({ schemaVersion: 1; tools: 'session-mcp' } | {
  schemaVersion: 2
  tools: { native: { source: string; toolNames: string[] }; mcp: string[] }
} | {
  schemaVersion: 3
  tools: { mcp: string[]; resultTransfer: ResultTransferLimits }
})

/** Explicit immutable retention settings; host protocol ceilings still apply. */
export interface ResultTransferLimits {
  version: 1
  maxResults: number
  maxBytes: number
  ttlSeconds: number
}

/** Immutable content identity supplied on installation and session creation. */
export interface AgentProfileRef {
  id: string
  version: string
  digest: string
}

/** Accepted profile and the exact MCP tool names retained across reconnects. */
export interface AgentProfileState extends AgentProfileRef {
  toolNames: string[]
  /** Hash of the backend-supplied native identity binding; never credentials. */
  nativeBindingDigest?: string
  /** Identity and protocol receipt for generic result transfer. */
  resultBindingDigest?: string
  resultTransfer?: ResultTransferLimits
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Profile identity and admitted tools committed before the first turn. */
    'agent-profile/selected': AgentProfileState
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One session committed a different agent preset to its durable log.
     * Consumers invalidate only state derived from that session's composition.
     * @mode emit
     * @param sessionId - the session whose composition changed.
     * @param agentPreset - the preset recorded by the committed selection.
     */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void
  }
}

export {}
