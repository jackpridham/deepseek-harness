/** Client-safe event declarations owned by the agent-preset domain. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Declarative assistant content; executable plugins and host paths are not accepted. */
export interface AgentProfileDefinition {
  schemaVersion: 1
  id: string
  version: string
  systemPrompt: string
  tools: 'session-mcp'
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
