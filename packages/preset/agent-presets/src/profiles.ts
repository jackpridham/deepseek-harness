/** Immutable assistant profiles owned by trusted application backends. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { AgentProfileDefinition, AgentProfileRef } from './types.ts'

/** Stable profile installation and selection errors. */
export class AgentProfileError extends Error {
  constructor(readonly code: 'agent-profile-invalid' | 'agent-profile-conflict' | 'agent-profile-not-found', message: string) {
    super(message)
  }
}

function invalid(message: string): never { throw new AgentProfileError('agent-profile-invalid', message) }

function assertIdentity(id: unknown, version: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
    || typeof version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(version)) {
    invalid('Profile id or version is invalid')
  }
}

/**
 * Validate untrusted JSON and produce the fixed key order used for hashing.
 * @param input - received or stored profile definition.
 * @returns validated content, without defaults or text normalization.
 */
export function parseAgentProfile(input: unknown): AgentProfileDefinition {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('Profile must be an object')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['schemaVersion', 'id', 'version', 'systemPrompt', 'tools'].includes(key))) invalid('Unknown profile field')
  assertIdentity(value.id, value.version)
  if (typeof value.systemPrompt !== 'string' || value.systemPrompt.length === 0
    || Buffer.byteLength(value.systemPrompt, 'utf8') > 65536) invalid('Profile requires 1–65536 UTF-8 bytes of systemPrompt')
  const common = { id: value.id, version: value.version as string, systemPrompt: value.systemPrompt }
  if (value.schemaVersion === 1 && value.tools === 'session-mcp') return { schemaVersion: 1, ...common, tools: 'session-mcp' }
  if (value.schemaVersion !== 2) invalid('Unsupported profile schemaVersion or tools')
  const tools = object(value.tools, ['native', 'mcp'])
  const native = object(tools.native, ['source', 'toolNames'])
  if (typeof native.source !== 'string' || !native.source.length || Buffer.byteLength(native.source, 'utf8') > 262144) invalid('Native source requires 1–262144 UTF-8 bytes')
  const toolNames = names(native.toolNames, false)
  if (!toolNames.length) invalid('Native tools cannot be empty')
  return { schemaVersion: 2, ...common, tools: { native: { source: native.source, toolNames }, mcp: names(tools.mcp, true) } }
}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) invalid('Invalid native tool declaration')
  return input as Record<string, unknown>
}

function names(input: unknown, mcp: boolean): string[] {
  if (!Array.isArray(input) || input.length > 128 || input.some(name => typeof name !== 'string'
    || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(name) || name === 'run_code' || name.startsWith('mcp__') !== mcp)
    || new Set(input).size !== input.length) invalid('Invalid or duplicate tool names')
  return input as string[]
}

/**
 * Hash compact UTF-8 JSON in schemaVersion/id/version/systemPrompt/tools order.
 * @param profile - declarative profile content.
 * @returns lowercase SHA-256 with the `sha256:` prefix.
 */
export function agentProfileDigest(profile: AgentProfileDefinition): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parseAgentProfile(profile))).digest('hex')}`
}

function directory(ref: Pick<AgentProfileRef, 'id' | 'version'>): string {
  assertIdentity(ref.id, ref.version)
  return dshHomePath('.agent-profiles', ref.id)
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) invalid('Profile storage must be an ordinary directory')
}

/**
 * Read and rehash an installed version, refusing missing or changed content.
 * @param ref - exact expected profile identity.
 * @returns the persisted definition.
 */
export async function loadAgentProfile(ref: AgentProfileRef): Promise<AgentProfileDefinition> {
  const dir = directory(ref)
  let content: string
  try {
    await assertDirectory(dshHomePath('.agent-profiles'))
    await assertDirectory(dir)
    const file = await open(join(dir, `${ref.version}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if ((await file.stat()).size > 512 * 1024) invalid('Stored profile exceeds the size limit')
      content = await file.readFile('utf8')
    } finally { await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentProfileError('agent-profile-not-found', 'Requested profile version is not installed')
    throw error
  }
  let json: unknown
  try { json = JSON.parse(content) }
  catch { invalid('Stored profile is not valid JSON') }
  const profile = parseAgentProfile(json)
  if (profile.id !== ref.id || profile.version !== ref.version || agentProfileDigest(profile) !== ref.digest) {
    throw new AgentProfileError('agent-profile-conflict', 'Profile version has different content or a different digest')
  }
  return profile
}

/**
 * Atomically install immutable content; concurrent identical requests share one file.
 * @param input - profile definition to validate and persist.
 * @param digest - caller's expected content digest.
 * @returns accepted identity and whether this call installed it.
 */
export async function installAgentProfile(
  input: AgentProfileDefinition, digest: string,
): Promise<{ profile: AgentProfileRef; created: boolean }> {
  const profile = parseAgentProfile(input)
  if (profile.schemaVersion === 2 && process.env.DSH_ALLOW_NATIVE_TOOLS !== '1') invalid('Native tool installation is disabled on this host')
  if (Buffer.byteLength(JSON.stringify(profile), 'utf8') > 512 * 1024) invalid('Serialized profile exceeds the size limit')
  if (agentProfileDigest(profile) !== digest) invalid('Profile digest does not match its content')
  const ref = { id: profile.id, version: profile.version, digest }
  const root = dshHomePath('.agent-profiles')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await assertDirectory(root)
  const dir = directory(ref)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await assertDirectory(dir)
  const temporary = join(dir, `.${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  let created = false
  try {
    try { await file.writeFile(JSON.stringify(profile)); await file.sync() }
    finally { await file.close() }
    try { await link(temporary, join(dir, `${profile.version}.json`)); created = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    await loadAgentProfile(ref)
  } finally { await unlink(temporary) }
  return { profile: ref, created }
}

/**
 * Create private state isolated by immutable profile, session and verified identity.
 * @param ref - installed profile identity.
 * @param sessionId - exact owning session.
 * @param bindingDigest - hash of the backend identity binding.
 * @returns service-owned directory, outside model-visible history and workspace.
 */
export async function nativeToolStateDirectory(ref: AgentProfileRef, sessionId: string, bindingDigest: string): Promise<string> {
  const root = dshHomePath('.native-tool-state')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await assertDirectory(root)
  const key = createHash('sha256').update(JSON.stringify([ref.id, ref.version, ref.digest, sessionId, bindingDigest])).digest('hex')
  const path = join(root, key)
  await mkdir(path, { mode: 0o700, recursive: true })
  await assertDirectory(path)
  return path
}
