/** Private, bounded canonical values for exact JSON Pointer argument transfer. */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ResultReference, ResultProvenance, ResultBinding } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ResultTransferLimits } from '@deepseek-ai/dsh-agent-presets/types'

const entrySchema = z.object({
  reference: z.string().regex(/^r_[a-f0-9]{24}$/),
  created: z.number(), expires: z.number(),
  provenance: z.object({ tool: z.string(), callId: z.string(), root: z.enum(['structuredContent', 'value']) }).strict(),
  digest: z.string(), value: z.json(),
}).strict()
type Entry = z.infer<typeof entrySchema>
const fileSchema = z.object({ version: z.literal(1), scope: z.string(), entries: z.array(entrySchema).max(128) }).strict()

function fail(code: string, message: string): never { throw new HarnessError(message, code) }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function digest(value: JsonValue): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** Durable per-session cache. Opening and capturing prune expired entries; reads never renew expiry. */
export class ResultStore {
  private entries: Entry[] = []
  private constructor(private directory: string, private scope: string, private limits: ResultTransferLimits) {}

  /**
   * Load a private store, rejecting corrupt values or a different trusted identity.
   * @param directory - session-owned directory outside the workspace.
   * @param scope - digest of session incarnation, immutable profile and trusted identity.
   * @param limits - immutable profile retention and quota settings.
   * @returns a ready cache; no tools are invoked during recovery.
   */
  static async open(directory: string, scope: string, limits: ResultTransferLimits): Promise<ResultStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RESULT_STORAGE_INVALID', 'Result storage must be a private directory')
    const store = new ResultStore(directory, scope, limits)
    let text: string | undefined
    try {
      const file = await open(join(directory, 'results.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if ((await file.stat()).size > limits.maxBytes) fail('RESULT_STORAGE_INVALID', 'Result storage exceeds quota')
        text = await file.readFile('utf8')
      } finally { await file.close() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (text !== undefined) {
      let parsed: z.infer<typeof fileSchema>
      try { parsed = fileSchema.parse(JSON.parse(text)) }
      catch { fail('RESULT_STORAGE_INVALID', 'Canonical result storage is invalid; values cannot be reconstructed from display text') }
      if (parsed.scope !== scope) fail('RESULT_SCOPE_MISMATCH', 'Canonical result scope differs from this session identity')
      if (new Set(parsed.entries.map(entry => entry.reference)).size !== parsed.entries.length
        || parsed.entries.some(entry => entry.digest !== digest(entry.value) || entry.expires < entry.created
          || entry.expires - entry.created > limits.ttlSeconds * 1000)) fail('RESULT_STORAGE_INVALID', 'Canonical result provenance is invalid')
      store.entries = parsed.entries.filter(entry => entry.expires > Date.now()).slice(-limits.maxResults)
      if (store.entries.length !== parsed.entries.length) await store.persist(store.entries)
    }
    return store
  }

  /** Number of retained, unexpired results. */
  get size(): number { return this.entries.filter(entry => entry.expires > Date.now()).length }

  private envelope(entries: Entry[]) { return { version: 1, scope: this.scope, entries } }

  private async persist(entries: Entry[]): Promise<void> {
    const path = join(this.directory, `.${randomBytes(12).toString('hex')}.tmp`)
    const file = await open(path, 'wx', 0o600)
    try {
      try { await file.writeFile(JSON.stringify(this.envelope(entries))); await file.sync() }
      finally { await file.close() }
      await rename(path, join(this.directory, 'results.json'))
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  /**
   * Commit a lossless canonical value before exposing its reference. Calls are serialized by the owning agent loop.
   * @param value - completed successful output, never rendered prose.
   * @param provenance - original execution and selection root.
   * @returns a new immutable session-scoped reference.
   */
  async capture(value: JsonValue, provenance: ResultProvenance): Promise<ResultReference> {
    const created = Date.now()
    const entry: Entry = { reference: `r_${randomBytes(12).toString('hex')}`, created, expires: created + this.limits.ttlSeconds * 1000,
      provenance, digest: digest(value), value: structuredClone(value) }
    if (bytes(this.envelope([entry])) > this.limits.maxBytes) fail('RESULT_QUOTA', 'Canonical result exceeds the storage quota')
    const entries = [...this.entries.filter(item => item.expires > created), entry].slice(-this.limits.maxResults)
    while (bytes(this.envelope(entries)) > this.limits.maxBytes) entries.shift()
    await this.persist(entries)
    this.entries = entries
    return entry.reference as ResultReference
  }

  /**
   * Read a detached selected value; unknown, retired and foreign references fail identically.
   * @param reference - handle previously exposed by this session.
   * @param pointer - RFC 6901 pointer; the empty string selects the whole root.
   * @returns the exact selected JSON value, including explicit null.
   */
  select(reference: string, pointer: string): JsonValue {
    const entry = this.entries.find(item => item.reference === reference)
    if (!entry || entry.expires <= Date.now()) fail('RESULT_UNAVAILABLE', 'Unknown, expired or foreign result reference')
    return structuredClone(at(entry.value, tokens(pointer)))
  }
}

function tokens(pointer: string): string[] {
  if (pointer === '') return []
  if (pointer.length > 2048 || !pointer.startsWith('/') || /~(?![01])/u.test(pointer)) fail('RESULT_POINTER_INVALID', 'Invalid JSON Pointer')
  return pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
}
function key(value: JsonValue, token: string): string {
  if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= value.length)) fail('RESULT_PATH_MISSING', 'JSON Pointer array element is missing')
  return token
}
function at(root: JsonValue, path: string[]): JsonValue {
  let value = root
  for (const token of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key(value, token))) fail('RESULT_PATH_MISSING', 'JSON Pointer path is missing')
    // oxlint-disable-next-line typescript/no-non-null-assertion -- own property checked above
    value = (value as Record<string, JsonValue>)[token]!
  }
  return value
}

/**
 * Copy selected values into absent object members or explicit array slots, without mutation of caller data.
 * @param store - caller session's canonical store.
 * @param args - literal target argument object; supplied object members cannot be overwritten.
 * @param bindings - independent, nonoverlapping destination pointers.
 * @returns resolved arguments bounded to 256 KiB of UTF-8 JSON, including all copied values.
 */
export function resolveBindings(store: ResultStore, args: Record<string, JsonValue>, bindings: ResultBinding[]): Record<string, JsonValue> {
  const resolved = structuredClone(args)
  const paths = bindings.map(binding => tokens(binding.target))
  for (const [index, path] of paths.entries()) {
    if (!path.length || paths.some((other, j) => j !== index && path.every((part, n) => other[n] === part))) fail('RESULT_BINDING_CONFLICT', 'Binding targets overlap or replace the argument root')
    const parent = at(resolved, path.slice(0, -1))
    // oxlint-disable-next-line typescript/no-non-null-assertion -- empty paths rejected above
    const member = path.at(-1)!
    if (parent === null || typeof parent !== 'object' || (!Array.isArray(parent) && Object.hasOwn(parent, member))) fail('RESULT_BINDING_CONFLICT', 'Binding target conflicts with supplied arguments or has no parent')
    // Array slots must already exist as null placeholders; indices never append or resize.
    if (Array.isArray(parent) && parent[Number(key(parent, member))] !== null) fail('RESULT_BINDING_CONFLICT', 'Array binding requires an explicit null placeholder')
    // oxlint-disable-next-line typescript/no-non-null-assertion -- paths and bindings have identical indices
    const binding = bindings[index]!
    const value = store.select(binding.result, binding.source)
    Object.defineProperty(parent, member, { value, writable: true, enumerable: true, configurable: true })
    if (bytes(resolved) > 262144) fail('RESULT_ARGUMENTS_TOO_LARGE', 'Resolved arguments are too large (maximum 262144 bytes)')
  }
  return resolved
}
