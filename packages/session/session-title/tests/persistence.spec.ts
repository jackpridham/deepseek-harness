import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

const CONFIG = {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
} as const

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function appendPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>, manual: boolean): Promise<void> {
  const session = ctx.sessions.create(id)
  session.append('turn/start', {
    turn: 1,
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Persist this session title' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await expect.poll(() => ctx.sessionTitle.get(session)?.title).toBe('Persist this session title')
  if (manual) ctx.sessionTitle.rename(session, 'My saved title')
  expect(ctx.sessionProjections.snapshot(session).values.title).toBe(manual ? 'My saved title' : 'Persist this session title')
}

async function expectPersistedTitle(ctx: Context, id: ReturnType<typeof SessionId>, manual: boolean): Promise<void> {
  const loaded = await ctx.sessionPersistence.load(id)
  expect(foldSessionTitle(loaded.events)).toMatchObject({
    title: manual ? 'My saved title' : 'Persist this session title',
    messageSeqs: manual ? [] : [1],
    source: { kind: manual ? 'user' : 'fallback' },
    eventSeq: manual ? 4 : 3,
  })
  expect(loaded.events.map(event => event.type)).toEqual([
    'turn/start',
    'user/message',
    'turn/end',
    'session/title',
    ...manual ? ['session/title'] : [],
  ])
  expect(ctx.sessionProjections.restore({}, loaded.events, 0).snapshot.values.title)
    .toBe(manual ? 'My saved title' : 'Persist this session title')
}

describe('session title persistence round trips', () => {
  it.each([false, true])('round-trips title and client projection through JSONL (manual=%s)', async (manual) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-jsonl-'))
    roots.push(root)
    const id = SessionId('title-jsonl')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendPersistedTitle(writer, id, manual)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(SessionTitleService, CONFIG)
    await reader.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await expectPersistedTitle(reader, id, manual)
    await reader.fiber.dispose()
  })

  it.each([false, true])('round-trips title and client projection through SQLite (manual=%s)', async (manual) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-title-sqlite-'))
    roots.push(root)
    const path = join(root, 'sessions.db')
    const id = SessionId('title-sqlite')
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(SessionProjectionRegistry)
    await writer.plugin(SqliteSessionPersistence, { path })
    await writer.plugin(SessionTitleService, CONFIG)
    await appendPersistedTitle(writer, id, manual)
    await writer.fiber.dispose()

    const reader = new Context()
    await reader.plugin(SessionStore)
    await reader.plugin(SessionProjectionRegistry)
    await reader.plugin(SessionTitleService, CONFIG)
    await reader.plugin(SqliteSessionPersistence, { path })
    await expectPersistedTitle(reader, id, manual)
    await reader.fiber.dispose()
  })
})
