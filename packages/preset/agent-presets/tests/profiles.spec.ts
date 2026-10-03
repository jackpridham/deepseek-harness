import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentProfileDigest, installAgentProfile, loadAgentProfile, parseAgentProfile } from '../src/profiles.ts'
import type { AgentProfileDefinition } from '../src/types.ts'

let root: string
const profile: AgentProfileDefinition = { schemaVersion: 1, id: 'business-assistant', version: '1.0.0', systemPrompt: 'Business assistant. {{literal}}', tools: 'session-mcp' }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-profiles-')); vi.stubEnv('DSH_HOME', root) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('pins native module bytes and the selected MCP names in an immutable v2 profile', async () => {
  const native = { ...profile, schemaVersion: 2, tools: { native: { source: 'export function createTools() { return [] }', toolNames: ['example_echo'] }, mcp: [] } } as unknown as AgentProfileDefinition
  await expect(installAgentProfile(native, agentProfileDigest(native))).rejects.toThrow('disabled')
  vi.stubEnv('DSH_ALLOW_NATIVE_TOOLS', '1')
  const receipt = await installAgentProfile(native, agentProfileDigest(native))
  expect(await loadAgentProfile(receipt.profile)).toEqual(native)
  expect((await installAgentProfile(native, receipt.profile.digest)).created).toBe(false)
  const changed = { ...native, tools: { native: { source: 'export function createTools() { throw Error() }', toolNames: ['example_echo'] }, mcp: [] } } as unknown as AgentProfileDefinition
  await expect(installAgentProfile(changed, agentProfileDigest(changed))).rejects.toMatchObject({ code: 'agent-profile-conflict' })
  for (const tools of [
    { native: { source: '', toolNames: ['example_echo'] }, mcp: [] },
    { native: { source: 'x', toolNames: ['example_echo', 'example_echo'] }, mcp: [] },
    { native: { source: 'x', toolNames: ['mcp__api__raw'] }, mcp: [] },
  ]) expect(() => parseAgentProfile({ ...native, tools })).toThrow()
})

it('uses portable fixed-order JSON hashing and atomically installs one immutable version under concurrency', async () => {
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(profile)).digest('hex')}`
  const reordered = {
    systemPrompt: profile.systemPrompt, version: profile.version, tools: profile.tools, id: profile.id, schemaVersion: 1 as const,
  }
  expect(agentProfileDigest(reordered)).toBe(digest)
  const results = await Promise.all(Array.from({ length: 8 }, () => installAgentProfile(profile, digest)))
  expect(results.filter(result => result.created)).toHaveLength(1)
  expect(await loadAgentProfile(results[0]!.profile)).toEqual(profile)
  expect(await readdir(join(root, '.agent-profiles', profile.id))).toEqual(['1.0.0.json'])
  const other = { ...profile, systemPrompt: 'Different' }
  await expect(installAgentProfile(other, agentProfileDigest(other))).rejects.toMatchObject({ code: 'agent-profile-conflict' })
  const next = { ...profile, version: '2' }
  expect((await installAgentProfile(next, agentProfileDigest(next))).created).toBe(true)
  expect(await loadAgentProfile(results[0]!.profile)).toEqual(profile)
})

it('rejects mismatched digests, executable fields, path traversal and unsupported versions before writing', async () => {
  await expect(installAgentProfile(profile, 'sha256:' + '0'.repeat(64))).rejects.toMatchObject({ code: 'agent-profile-invalid' })
  for (const input of [null, [], { ...profile, id: '../x' }, { ...profile, version: '..' }, { ...profile, schemaVersion: 2 }, { ...profile, cordis: '!!js evil' }, { ...profile, tools: 'shell' }, { ...profile, systemPrompt: '' }, { ...profile, systemPrompt: '🌍'.repeat(16385) }]) {
    expect(() => parseAgentProfile(input)).toThrow()
  }
  expect(await readdir(root)).toEqual([])
})

it('refuses missing, corrupted, oversized and modified stored content', async () => {
  const ref = { id: profile.id, version: profile.version, digest: agentProfileDigest(profile) }
  await expect(loadAgentProfile(ref)).rejects.toMatchObject({ code: 'agent-profile-not-found' })
  await installAgentProfile(profile, ref.digest)
  const path = join(root, '.agent-profiles', profile.id, `${profile.version}.json`)
  for (const [content, code] of [
    ['{', 'agent-profile-invalid'],
    [' '.repeat(512 * 1024 + 1), 'agent-profile-invalid'],
    [JSON.stringify({ ...profile, systemPrompt: 'Changed' }), 'agent-profile-conflict'],
  ]) {
    await writeFile(path, content!)
    await expect(loadAgentProfile(ref)).rejects.toMatchObject({ code })
  }
})

it('does not follow a symlink occupying a version slot', async () => {
  const installed = await installAgentProfile(profile, agentProfileDigest(profile))
  const target = join(root, '.agent-profiles', profile.id, `${profile.version}.json`)
  const other = join(root, 'private.json')
  await writeFile(other, 'untouched')
  await rm(target)
  await symlink(other, target)
  await expect(loadAgentProfile(installed.profile)).rejects.toThrow()
  await expect(installAgentProfile(profile, installed.profile.digest)).rejects.toThrow()
  expect(await readFile(other, 'utf8')).toBe('untouched')
})
