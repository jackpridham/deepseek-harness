/** Session composition and durable identity for backend-installed assistant profiles. */
import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AgentProfileError, loadAgentProfile, nativeToolStateDirectory } from '@deepseek-ai/dsh-agent-presets'
import type { AgentProfileRef, AgentProfileState } from '@deepseek-ai/dsh-agent-presets/types'
import { SessionPolicyId, type Session, type SessionInstructions } from '@deepseek-ai/dsh-session'
import type { SessionMcpAttachment } from './api/sessions.ts'
import { mountMcpAttachment, mcpAttachmentState, SessionMcpError } from './session-mcp.ts'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Generic MCP-only composition, selected implicitly by session.create.agentProfile. */
export const AGENT_PROFILE_POLICY = SessionPolicyId('managed-agent-profile-v1')
/** Managed composition admitting backend-installed native tools and an explicit MCP subset. */
export const NATIVE_PROFILE_POLICY = SessionPolicyId('managed-agent-profile-v2')

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

function bindingDigest(binding?: Record<string, string>): string {
  if (binding === undefined) throw new AgentProfileError('agent-profile-invalid', 'Profile v2 requires nativeToolBinding on creation and resume')
  return `sha256:${createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(binding).sort().map(key => [key, binding[key]])))).digest('hex')}`
}

/**
 * Refuse adopting a native session under a different backend identity.
 * @param agent - live session being attached.
 * @param binding - caller's verified identity; no credentials.
 */
export function assertNativeToolBinding(agent: Agent, binding?: Record<string, string>): void {
  const stored = sessionProfileState(agent.session)?.nativeBindingDigest
  if (stored !== undefined && stored !== bindingDigest(binding)) throw new AgentProfileError('agent-profile-conflict', 'Native tool identity differs from the recorded session')
  if (stored === undefined && binding !== undefined) throw new AgentProfileError('agent-profile-invalid', 'nativeToolBinding requires a v2 profile')
}

/**
 * Register generic profile restrictions at the same lifetime as the gateway.
 * @param ctx - gateway context owning the policy registration.
 */
export function registerAgentProfilePolicy(ctx: Context): void {
  const policies = process.env.DSH_ALLOW_NATIVE_TOOLS === '1' ? [AGENT_PROFILE_POLICY, NATIVE_PROFILE_POLICY] : [AGENT_PROFILE_POLICY]
  for (const id of policies) ctx.agents.registerPolicy({
    id, instructions: false, workspace: false, presets: false, fork: false,
    attestation: { tools: id === AGENT_PROFILE_POLICY ? 'session-mcp' : 'profile-native-mcp', immutableProfile: true },
    apply(agent) {
      const profile = sessionProfileState(agent.session)
      if (profile === undefined) throw new AgentProfileError('agent-profile-invalid', 'Profile composition is required before publication')
      agent.ctx.tools.allowOnlyTools(profile.toolNames)
      agent.ctx.systemPrompt.suppressRuntimeContext()
    },
  })
}

/**
 * Restore immutable instructions and mount the selected session tools before publication.
 * @param ctx - unpublished agent context.
 * @param requested - exact profile for a new session or explicit resume.
 * @param attachment - user-scoped MCP credentials, supplied again after restart.
 * @param binding - verified identity for native tools, supplied again on every attachment.
 */
export async function mountSessionProfile(
  ctx: Context, requested?: AgentProfileRef, attachment?: SessionMcpAttachment, binding?: Record<string, string>,
): Promise<void> {
  const agent = ctx.agent
  if (agent === undefined) throw new Error('Profile composition requires a session agent')
  const stored = sessionProfileState(agent.session)
  if (stored !== undefined) assertSessionProfile(agent, requested)
  const ref = stored ?? requested
  if (ref === undefined) throw new AgentProfileError('agent-profile-invalid', 'session.create requires an exact agentProfile reference')
  const definition = await loadAgentProfile(ref)
  if (attachment === undefined && (definition.schemaVersion === 1 || definition.tools.mcp.length > 0)) throw new SessionMcpError('mcp-attachment-required', 'Create or resume this profile session with its user-scoped MCP attachment')
  const nativeBindingDigest = definition.schemaVersion === 2 ? bindingDigest(binding) : undefined
  if (stored !== undefined) assertNativeToolBinding(agent, binding)
  if (definition.schemaVersion === 1 && binding !== undefined) throw new AgentProfileError('agent-profile-invalid', 'nativeToolBinding requires a v2 profile')
  ctx.tools.presentAs('native')
  ctx.tools.restrict({ allow: [] })
  await mountMcpAttachment(ctx, attachment)
  const attached = mcpAttachmentState(agent)
  let toolNames = attached?.toolNames ?? []
  if (definition.schemaVersion === 2) {
    if (process.env.DSH_ALLOW_NATIVE_TOOLS !== '1') throw new AgentProfileError('agent-profile-invalid', 'Native tools are disabled on this host')
    if (definition.tools.mcp.some(name => !toolNames.includes(name))) throw new AgentProfileError('agent-profile-invalid', 'Selected MCP tool is unavailable')
    try {
      // ponytail: one bundled ESM module per immutable profile; add package resolution only for a real dependency need.
      const url = `data:text/javascript;base64,${Buffer.from(definition.tools.native.source).toString('base64')}`
      const module = await import(/* @vite-ignore */ url) as {
        createTools: (options: unknown) => Promise<ToolDefinition[]> | ToolDefinition[]
      }
      if (typeof module.createTools !== 'function') throw new Error('Missing createTools export')
      const tools = await module.createTools({
        sessionId: agent.session.id, binding: structuredClone(binding),
        stateDirectory: await nativeToolStateDirectory(ref, agent.session.id, bindingDigest(binding)),
        mcpAttachment: structuredClone(attachment),
      })
      if (!Array.isArray(tools) || !isDeepStrictEqual(tools.map(tool => tool.name).sort(), [...definition.tools.native.toolNames].sort())
        || tools.some(tool => typeof tool.execute !== 'function' || typeof tool.description !== 'string' || !tool.parameters)) throw new Error('Invalid native tool definitions')
      for (const tool of tools) {
        assertObjectJsonSchema(tool.parameters)
        ctx.tools.register({ ...tool, async execute(args, exec) {
          if (validateJsonSchemaValue(tool.parameters, args, 'arguments').length) throw new Error('Invalid native tool arguments')
          return tool.execute(args, exec)
        } })
      }
    } catch {
      // Module errors may contain private credentials supplied to the factory.
      throw new AgentProfileError('agent-profile-invalid', 'Native tool module failed to load or its definitions differ from the declared roster')
    }
    toolNames = [...definition.tools.mcp, ...definition.tools.native.toolNames].sort()
  }
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
  if (stored === undefined) agent.session.append('agent-profile/selected', { id: ref.id, version: ref.version, digest: ref.digest, toolNames,
    ...nativeBindingDigest === undefined ? {} : { nativeBindingDigest } })
}
