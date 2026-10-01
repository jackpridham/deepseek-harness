/** Session composition and durable identity for backend-installed assistant profiles. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentProfileError, loadAgentProfile } from '@deepseek-ai/dsh-agent-presets'
import type { AgentProfileRef, AgentProfileState } from '@deepseek-ai/dsh-agent-presets/types'
import { SessionPolicyId, type Session, type SessionInstructions } from '@deepseek-ai/dsh-session'
import type { SessionMcpAttachment } from './api/sessions.ts'
import { mountMcpAttachment, mcpAttachmentState, SessionMcpError } from './session-mcp.ts'

/** Generic MCP-only composition, selected implicitly by session.create.agentProfile. */
export const AGENT_PROFILE_POLICY = SessionPolicyId('managed-agent-profile-v1')

/**
 * Read the committed profile selection without loading or changing a session.
 * @param session - session whose complete log owns its profile.
 * @returns its accepted identity and tools, when configured.
 */
export function sessionProfileState(session: Pick<Session, 'events'>): AgentProfileState | undefined {
  const event = session.events.find(event => event.type === 'agent-profile/selected')
  return event?.type === 'agent-profile/selected' ? event.data : undefined
}

/**
 * Refuse replacing an existing conversation's profile, including before its first turn.
 * @param agent - published session agent.
 * @param requested - caller's exact profile, when supplied.
 */
export function assertSessionProfile(agent: Agent, requested?: AgentProfileRef): void {
  if (requested === undefined) return
  const stored = sessionProfileState(agent.session)
  if (stored === undefined || stored.id !== requested.id || stored.version !== requested.version || stored.digest !== requested.digest) {
    throw new AgentProfileError('agent-profile-conflict', 'The session has a different profile; create a new session')
  }
}

/**
 * Register generic profile restrictions at the same lifetime as the gateway.
 * @param ctx - gateway context owning the policy registration.
 */
export function registerAgentProfilePolicy(ctx: Context): void {
  ctx.agents.registerPolicy({
    id: AGENT_PROFILE_POLICY, instructions: false, workspace: false, presets: false, fork: false,
    attestation: { tools: 'session-mcp', immutableProfile: true },
    apply(agent) {
      const profile = sessionProfileState(agent.session)
      if (profile === undefined) throw new AgentProfileError('agent-profile-invalid', 'Profile composition is required before publication')
      agent.ctx.tools.allowOnlyTools(profile.toolNames)
      agent.ctx.systemPrompt.suppressRuntimeContext()
    },
  })
}

/**
 * Restore immutable instructions and attach only this session's MCP server before publication.
 * @param ctx - unpublished agent context.
 * @param requested - exact profile for a new session or explicit resume.
 * @param attachment - user-scoped MCP credentials, supplied again after restart.
 */
export async function mountSessionProfile(ctx: Context, requested?: AgentProfileRef, attachment?: SessionMcpAttachment): Promise<void> {
  const agent = ctx.agent
  if (agent === undefined) throw new Error('Profile composition requires a session agent')
  const stored = sessionProfileState(agent.session)
  if (stored !== undefined) assertSessionProfile(agent, requested)
  const ref = stored ?? requested
  if (ref === undefined) throw new AgentProfileError('agent-profile-invalid', 'session.create requires an exact agentProfile reference')
  const definition = await loadAgentProfile(ref)
  if (attachment === undefined) throw new SessionMcpError('mcp-attachment-required', 'Create or resume this profile session with its user-scoped MCP attachment')
  ctx.tools.presentAs('native')
  ctx.tools.restrict({ allow: [] })
  await mountMcpAttachment(ctx, attachment)
  const attached = mcpAttachmentState(agent)
  if (attached === undefined) throw new Error('Profile MCP attachment was not mounted')
  const { toolNames } = attached
  if (stored !== undefined && !isDeepStrictEqual(stored.toolNames, toolNames)) {
    throw new AgentProfileError('agent-profile-conflict', 'The MCP tool set differs from the recorded session; create a new session')
  }
  const instructions: SessionInstructions = {
    version: 1,
    systemPrompt: { base: { mode: 'replace', text: definition.systemPrompt } },
    contextSources: { harnessInstructions: 'off', workspaceInstructions: 'off', skillCatalog: 'off', runtimeFacts: 'off' },
  }
  if (stored !== undefined && !isDeepStrictEqual(agent.session.getInstructions().instructions, instructions)) {
    throw new AgentProfileError('agent-profile-conflict', 'Recorded instructions differ from the installed profile')
  }
  agent.session.configureInstructions(instructions)
  if (stored === undefined) agent.session.append('agent-profile/selected', { id: ref.id, version: ref.version, digest: ref.digest, toolNames })
}
