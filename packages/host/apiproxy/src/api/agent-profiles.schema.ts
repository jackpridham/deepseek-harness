/** Browser-safe wire validation for declarative, immutable assistant profiles. */
import { z } from 'zod'
import type { AgentProfileDefinition, AgentProfileRef, AgentProfileState } from '@deepseek-ai/dsh-agent-presets/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
const version = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/** Exact reference retained by the caller for reconnects. */
export const agentProfileRefSchema = z.object({ id, version, digest }).strict() satisfies z.ZodType<AgentProfileRef>
/** Data-only profile; arbitrary Cordis composition is not an installation input. */
const profileV1 = z.object({
  schemaVersion: z.literal(1), id, version,
  systemPrompt: z.string().min(1).max(65536),
  tools: z.literal('session-mcp'),
}).strict()
/** Trusted native module and explicit MCP subset, hashed with the prompt. */
export const agentProfileDefinitionSchema = z.union([profileV1, profileV1.extend({
  schemaVersion: z.literal(2),
  tools: z.object({
    native: z.object({ source: z.string().min(1).max(262144), toolNames: z.array(z.string()).min(1).max(128) }).strict(),
    mcp: z.array(z.string()).max(128),
  }).strict(),
}).strict()]) satisfies z.ZodType<AgentProfileDefinition>
/** Private identity supplied by the trusted backend, with no bearer credentials. */
export const nativeToolBindingSchema = z.record(z.string().min(1).max(64), z.string().max(512))
  .refine(value => Object.keys(value).length <= 32)
/** Accepted session profile and discovered tool names. */
export const agentProfileStateSchema = agentProfileRefSchema.extend({
  toolNames: z.array(z.string()),
  nativeBindingDigest: digest.optional(),
}).transform(({ nativeBindingDigest, ...state }) =>
  nativeBindingDigest === undefined ? state : { ...state, nativeBindingDigest },
) satisfies z.ZodType<AgentProfileState>
/** Trusted service installation request. */
export const agentPresetInstallProfileRequestSchema = z.object({ profile: agentProfileDefinitionSchema, digest }).strict() satisfies z.ZodType<Wire<RequestPayload<'agentPreset.installProfile'>>>
/** Installation acknowledgement; created is false for identical retries. */
export const agentPresetInstallProfileValueSchema = z.object({ profile: agentProfileRefSchema, created: z.boolean() }) satisfies z.ZodType<Wire<ResponseValue<'agentPreset.installProfile'>>>
