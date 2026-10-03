import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ResultStore, resolveBindings } from '../src/result-store.ts'

const dirs: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const limits = { version: 1 as const, maxResults: 2, maxBytes: 4096, ttlSeconds: 60 }
async function store(scope = 'scope-a') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-results-')); dirs.push(dir)
  return { dir, cache: await ResultStore.open(dir, scope, limits) }
}
const provenance = { tool: 'mcp__fixture__search', callId: 'search-1', root: 'structuredContent' as const }

it('persists exact JSON values and provenance before returning a reference; recovery does not call tools', async () => {
  const { cache, dir } = await store()
  const row = { id: 'Z'.repeat(152), mailbox: 'α😀\u0000e\u0301', nested: [null, true, 42, { 'a/b~c': 'unchanged' }] }
  const ref = await cache.capture({ messages: [row] }, provenance)
  expect(ref).toMatch(/^r_[a-f0-9]{24}$/)
  row.id = 'later mutation'
  const restored = await ResultStore.open(dir, 'scope-a', limits)
  row.id = 'Z'.repeat(152)
  expect(restored.select(ref, '/messages/0')).toEqual(row)
  expect(restored.select(ref, '/messages/0/nested/0')).toBeNull()
  expect(restored.select(ref, '/messages/0/nested/3/a~1b~0c')).toBe('unchanged')
  const result = resolveBindings(restored, { bodyOffset: 0 }, [
    { result: ref, source: '/messages/0/id', target: '/messageID' },
    { result: ref, source: '/messages/0/mailbox', target: '/mailboxGUID' },
    { result: ref, source: '/messages/0/nested', target: '/data' },
  ])
  expect(result).toEqual({ bodyOffset: 0, messageID: row.id, mailboxGUID: row.mailbox, data: row.nested })
  expect(JSON.parse(await readFile(join(dir, 'results.json'), 'utf8')) as unknown).toMatchObject({ entries: [{ provenance }] })
  await expect(ResultStore.open(dir, 'wrong-identity', limits)).rejects.toThrow(/scope/i)
})

it('rejects foreign, missing and malformed paths and conflicting destinations without modifying input', async () => {
  const { cache } = await store()
  const { cache: other } = await store()
  const ref = await cache.capture({ a: { b: 'original' }, list: ['first'], value: null }, provenance)
  expect(() => other.select(ref, '')).toThrow(/unknown|expired/i)
  for (const path of ['/missing', '/a/no', '/list/01', '/list/-', '/a~2', 'a', '/toString']) expect(() => cache.select(ref, path)).toThrow()
  const args = { a: { c: 'keep' } }
  for (const targets of [['/a', '/a/b'], ['/x', '/x'], ['/a/c'], ['/absent/child']]) {
    expect(() => resolveBindings(cache, args, targets.map(target => ({ target, source: '/a/b', result: ref })))).toThrow()
  }
  expect(args).toEqual({ a: { c: 'keep' } })
  expect(resolveBindings(cache, { list: [null] }, [{ target: '/list/0', source: '/list/0', result: ref }])).toEqual({ list: ['first'] })
  expect(() => resolveBindings(cache, { list: [] }, [{ target: '/list/0', source: '/value', result: ref }])).toThrow()
  expect(() => resolveBindings(cache, { list: ['literal'] }, [{ target: '/list/0', source: '/value', result: ref }])).toThrow()
  const bound = resolveBindings(cache, {}, [{ target: '/__proto__', source: '/a', result: ref }])
  expect(Object.hasOwn(bound, '__proto__')).toBe(true)
  expect({}).not.toHaveProperty('b')
})

it('retires oldest references under quota, expires without sliding renewal and rejects oversize arguments', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-03T00:00:00Z'))
  const { cache, dir } = await store()
  const first = await cache.capture('one', provenance)
  await cache.capture('two', provenance)
  await cache.capture('three', provenance)
  expect(() => cache.select(first, '')).toThrow()
  const ref = await cache.capture('😀'.repeat(800), provenance)
  expect(() => resolveBindings(cache, { tooLarge: 'x'.repeat(262144) }, [{ target: '/x', source: '', result: ref }])).toThrow(/large/i)
  await expect(cache.capture('x'.repeat(5000), provenance)).rejects.toThrow(/quota/i)
  vi.advanceTimersByTime(60001)
  expect(() => cache.select(ref, '')).toThrow(/expired/i)
  expect((await ResultStore.open(dir, 'scope-a', limits)).size).toBe(0)
})
