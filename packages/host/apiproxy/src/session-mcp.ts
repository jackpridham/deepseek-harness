/** Session-owned HTTP MCP attachment, using the stock client and agent teardown. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { SessionMcpAttachment, SessionMcpAttachmentState } from './api/sessions.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required server identity; credentials must be supplied again after teardown. */
    'mcp/attached': { version: 1; serverName: string; url: string }
  }
}

const attachments = new WeakMap<Agent, SessionMcpAttachment>()

/** An attachment could not be installed or conflicts with the session identity. */
export class SessionMcpError extends Error {
  constructor(readonly code: 'mcp-attachment-conflict' | 'mcp-attachment-required' | 'mcp-attachment-failed' | 'mcp-attachment-policy', message: string) { super(message) }
}

/**
 * Reject replacement on a live session; an identical request only inspects it.
 * @param agent - the existing session agent.
 * @param requested - attachment supplied by the caller, if any.
 */
export function assertMcpAttachment(agent: Agent, requested?: SessionMcpAttachment): void {
  if (requested !== undefined && !isDeepStrictEqual(attachments.get(agent), requested)) {
    throw new SessionMcpError('mcp-attachment-conflict', 'The live session has a different MCP attachment; create a new session.')
  }
}

/**
 * Install the server before publication and restore its identity on explicit resume.
 * @param ctx - session agent context owning the connection and tools.
 * @param requested - HTTP endpoint and credentials supplied at session creation.
 */
export async function mountMcpAttachment(ctx: Context, requested?: SessionMcpAttachment): Promise<void> {
  const agent = ctx.agent
  if (agent === undefined) throw new Error('MCP attachment requires a session agent')
  const recorded = agent.session.events.find(event => event.type === 'mcp/attached')
  if (recorded !== undefined && requested === undefined) {
    throw new SessionMcpError('mcp-attachment-required', 'Resume this session with session.create and its MCP attachment before submitting a task.')
  }
  if (requested === undefined) return
  if (recorded?.type === 'mcp/attached' && (recorded.data.serverName !== requested.serverName || recorded.data.url !== requested.url)) {
    throw new SessionMcpError('mcp-attachment-conflict', 'The MCP server identity differs from the recorded session.')
  }
  const attachment = structuredClone(requested)
  try {
    await mcpClient.apply(ctx, { ...attachment, reconnect: { enabled: false } })
  } catch (error: unknown) {
    throw new SessionMcpError('mcp-attachment-failed', `MCP initialization or tool discovery failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.effect(() => {
    attachments.set(agent, attachment)
    return () => { attachments.delete(agent) }
  }, 'session-mcp.attachment')
  if (recorded === undefined) agent.session.append('mcp/attached', { version: 1, serverName: attachment.serverName, url: attachment.url })
}

/**
 * Inspect the tools installed for this session without performing remote calls.
 * @param agent - the live session agent.
 * @returns initial-discovery state, absent for an ordinary session.
 */
export function mcpAttachmentState(agent: Agent): SessionMcpAttachmentState | undefined {
  const attachment = attachments.get(agent)
  if (attachment === undefined) return undefined
  const tools = agent.ctx.get('tools')
  if (tools === undefined) throw new Error('MCP attachment requires the tool registry')
  return {
    version: 1,
    serverName: attachment.serverName,
    toolNames: tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith(`mcp__${attachment.serverName}__`)).sort(),
  }
}
