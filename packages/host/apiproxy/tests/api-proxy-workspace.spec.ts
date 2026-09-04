import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryPickerCapability } from '@deepseek-ai/dsh-host-directory-picker'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { HostFrame, WorkspaceId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest, RpcResponse } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

let nextRpc = 1

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`workspace-${String(nextRpc++)}`), payload }
}

function expectOk<T>(response: RpcResponse<T>): T {
  expect(response.result.ok).toBe(true)
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

async function nextHostFrame(
  stream: AsyncIterator<RpcRequest<HostFrame>>,
): Promise<RpcRequest<HostFrame>> {
  const next = await stream.next()
  if (next.done === true) throw new Error('Host stream ended before the expected increment')
  return next.value
}

function stubAgent(session: Session, agentCtx = new Context()): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Compose the API over real Session, Agent, Storage, Domain, and Workspace services. */
async function harness(
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-'))),
  picker: DirectoryPickerCapability = { kind: 'native', pick: async () => null },
  extras: {
    openPath?: (path: string, signal: AbortSignal) => Promise<void>
    canOpenPath?: () => boolean
    parents?: ReadonlyMap<SessionId, SessionId>
    persisted?: SessionHeader[]
    resumeGate?: Promise<void>
  } = {},
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  const persisted = [...extras.persisted ?? []]
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([...persisted]),
    inspect: (id: SessionId) => {
      const meta = persisted.find(header => header.id === id)
      return meta === undefined
        ? Promise.reject(new Error(`test harness has no persisted session ${id}`))
        : Promise.resolve({ meta, events: [] })
    },
    delete: (id: SessionId) => {
      const index = persisted.findIndex(header => header.id === id)
      if (index !== -1) persisted.splice(index, 1)
      return Promise.resolve()
    },
  } as never)
  ctx.provide('attachments', {
    collectGarbage: () => Promise.resolve(0),
  } as never)
  await ctx.plugin(WorkspaceRegistry)
  const handleDisposals: SessionId[] = []

  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      const parentSession = extras.parents?.get(options.sessionId)
      const session = ctx.sessions.prepare(
        options.sessionId,
        options.meta === undefined && parentSession === undefined
          ? {}
          : { meta: { ...options.meta, ...parentSession === undefined ? {} : { parentSession } } },
      )
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agentCtx = new Context()
      const agent = stubAgent(session, agentCtx)
      const unregister = ctx.agents.register(agent)
      const handle: AgentHandle = {
        agent,
        async dispose() {
          handleDisposals.push(agent.id)
          unregister()
          detachSession()
          await agentCtx.fiber.dispose()
        },
      }
      return handle
    },
    async resume(_ownerCtx, options) {
      await extras.resumeGate
      const inspected = await ctx.sessionPersistence.inspect(options.resumeSessionId)
      const session = ctx.sessions.prepare(inspected.meta.id, {
        meta: structuredClone(inspected.meta),
        seed: structuredClone([...inspected.events]),
        seedSource: 'persistence',
      })
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agentCtx = new Context()
      const agent = stubAgent(session, agentCtx)
      const unregister = ctx.agents.register(agent)
      const handle: AgentHandle = {
        agent,
        async dispose() {
          handleDisposals.push(agent.id)
          unregister()
          detachSession()
          await agentCtx.fiber.dispose()
        },
      }
      return handle
    },
  }
  ctx.agents.setFactory(factory)
  // Structural picker fake: the gateway only reads capability(); a stable
  // object per harness mirrors the seam's stability contract.
  ctx.provide('directoryPicker', { capability: () => picker } as never)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: root,
    ...extras.openPath === undefined ? {} : { openPath: extras.openPath },
    ...extras.canOpenPath === undefined ? {} : { canOpenPath: extras.canOpenPath },
  })
  return { api, ctx, storageDomain, root, handleDisposals }
}

/** Stage one directory under the harness root for path adoption. */
function stageDir(root: string, name: string): string {
  const path = join(root, name)
  mkdirSync(path)
  return path
}

describe('host.pickDirectory', () => {
  it('returns a selected path or explicit cancellation from the native capability', async () => {
    const selected = await harness(undefined, { kind: 'native', pick: async () => '/tmp/project' })
    expect((await selected.api.host.pickDirectory(request({}), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { path: '/tmp/project' } })

    const cancelled = await harness(undefined, { kind: 'native', pick: async () => null })
    expect((await cancelled.api.host.pickDirectory(request({}), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { path: null } })
  })

  it('propagates abort into the native capability as a cancelled RPC error', async () => {
    const { api } = await harness(undefined, {
      kind: 'native',
      pick: signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.pickDirectory(request({}), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('folds a non-abort native-chooser failure into an internal error', async () => {
    const { api } = await harness(undefined, { kind: 'native', pick: async () => { throw new Error('no chooser installed') } })
    const response = await api.host.pickDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('refuses the native RPC under a browse composition', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    const response = await api.host.pickDirectory(request({}), new AbortController().signal)
    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'directory-picker-unavailable', details: { capability: 'browse' } },
    })
  })
})

/** Canned browse capability: one listing, one created path, typed failures on demand. */
const BROWSE_STUB: DirectoryPickerCapability = {
  kind: 'browse',
  list: async (path) => {
    if (path === '/denied') throw new DirectoryPickerError('directory-unreadable', '/denied', 'cannot list /denied')
    const target = path ?? '/home/user'
    return {
      path: target,
      home: '/home/user',
      crumbs: [{ name: '/', path: '/', hidden: false }],
      entries: [{ name: 'projects', path: `${target}/projects`, hidden: false }],
      truncated: false,
    }
  },
  createDirectory: async (path, name) => {
    if (name === 'taken') throw new DirectoryPickerError('directory-exists', `${path}/${name}`, 'already exists')
    if (name === 'unwritable') throw new Error('disk detached')
    return `${path}/${name}`
  },
}

describe('host.listDirectory / host.createDirectory', () => {
  it('serves listings and creation through the browse capability, defaulting to home', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    const home = await api.host.listDirectory(request({}), new AbortController().signal)
    expect(home.result).toMatchObject({ ok: true, value: { path: '/home/user', home: '/home/user' } })
    const listed = await api.host.listDirectory(request({ path: '/home/user/projects' }), new AbortController().signal)
    expect(listed.result).toMatchObject({ ok: true, value: { path: '/home/user/projects' } })
    const created = await api.host.createDirectory(request({ path: '/home/user', name: 'fresh' }))
    expect(created.result).toEqual({ ok: true, value: { path: '/home/user/fresh' } })
  })

  it('maps typed picker failures onto the wire error codes and folds unknown throws to internal', async () => {
    const { api } = await harness(undefined, BROWSE_STUB)
    expect((await api.host.listDirectory(request({ path: '/denied' }), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'directory-unreadable', details: { path: '/denied' } },
    })
    expect((await api.host.createDirectory(request({ path: '/home/user', name: 'taken' }))).result).toMatchObject({
      ok: false, error: { code: 'directory-exists' },
    })
    expect((await api.host.createDirectory(request({ path: '/home/user', name: 'unwritable' }))).result).toMatchObject({
      ok: false, error: { code: 'internal' },
    })
  })

  it('reports an aborted listing as cancelled, like the other signal-following RPCs', async () => {
    const { api } = await harness(undefined, {
      kind: 'browse',
      list: (_path, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('scan aborted')) }, { once: true })
      }),
      createDirectory: async () => '/never',
    })
    const abort = new AbortController()
    const pending = api.host.listDirectory(request({}), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('refuses the browse RPCs under a native composition', async () => {
    const { api } = await harness()
    expect((await api.host.listDirectory(request({}), new AbortController().signal)).result).toMatchObject({
      ok: false, error: { code: 'directory-picker-unavailable', details: { capability: 'native' } },
    })
    expect((await api.host.createDirectory(request({ path: '/x', name: 'y' }))).result).toMatchObject({
      ok: false, error: { code: 'directory-picker-unavailable', details: { capability: 'native' } },
    })
  })
})

describe('host.openPath', () => {
  it('describes whether this deployment can reach a user-visible native desktop', async () => {
    const visible = await harness(undefined, undefined, { canOpenPath: () => true })
    const headless = await harness(undefined, undefined, { canOpenPath: () => false })
    expect(expectOk(await visible.api.host.describe(request({}))).canOpenPath).toBe(true)
    expect(expectOk(await headless.api.host.describe(request({}))).canOpenPath).toBe(false)
    expect(expectOk(await visible.api.host.describe(request({}))).home).toBe(homedir())
  })

  it('opens through the injected native boundary', async () => {
    const opened: string[] = []
    const { api } = await harness(undefined, undefined, {
      openPath: async (path) => { opened.push(path) },
    })
    expect((await api.host.openPath(request({ path: '/tmp/a.txt' }), new AbortController().signal)).result)
      .toEqual({ ok: true, value: { opened: true } })
    expect(opened).toEqual(['/tmp/a.txt'])
  })

  it('propagates abort into the native boundary as a cancelled RPC error', async () => {
    const { api } = await harness(undefined, undefined, {
      openPath: (_path, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }),
    })
    const abort = new AbortController()
    const pending = api.host.openPath(request({ path: '/tmp/a.txt' }), abort.signal)
    abort.abort()
    expect((await pending).result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('workspace.create', () => {
  it('serializes concurrent creates of one path into a single registration', async () => {
    const { api, root } = await harness()
    const target = stageDir(root, 'alpha')
    const responses = await Promise.all([
      api.workspace.create(request({ path: target })),
      api.workspace.create(request({ path: target })),
    ])
    const values = responses.map(response => expectOk(response))
    const created = values.find(value => value.created)
    const resolved = values.find(value => !value.created)

    expect(created).toMatchObject({ workspace: { path: target, title: 'alpha' } })
    expect(resolved?.workspace.workspaceId).toBe(created?.workspace.workspaceId)
    expect(expectOk(await api.workspace.list(request({}))).items).toHaveLength(1)
  })

  it('adopts only existing directories', async () => {
    const { api, root } = await harness()
    const existing = stageDir(root, 'existing')
    const first = expectOk(await api.workspace.create(request({ path: existing })))
    const repeated = expectOk(await api.workspace.create(request({ path: existing })))
    expect(first).toMatchObject({ created: true, workspace: { path: existing, title: 'existing' } })
    expect(repeated).toMatchObject({ created: false, workspace: { workspaceId: first.workspace.workspaceId } })

    expectOk(await api.workspace.rename(request({
      workspaceId: first.workspace.workspaceId,
      title: 'renamed-existing',
    })))
    const reopened = expectOk(await api.workspace.create(request({ path: existing })))
    expect(reopened.workspace.title).toBe('renamed-existing')

    const missing = join(root, 'missing')
    const missingResult = await api.workspace.create(request({ path: missing }))
    expect(missingResult.result).toMatchObject({ ok: false, error: { code: 'workspace-invalid-path' } })
    expect(existsSync(missing)).toBe(false)
  })

  it('adopts different paths that derive the same Workspace title', async () => {
    const { api, root } = await harness()
    const first = join(root, 'one', 'project')
    const second = join(root, 'two', 'project')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const firstResult = expectOk(await api.workspace.create(request({ path: first })))
    const secondResult = expectOk(await api.workspace.create(request({ path: second })))
    expect(firstResult).toMatchObject({
      created: true,
      workspace: { path: first, title: 'project' },
    })
    expect(secondResult).toMatchObject({
      created: true,
      workspace: { path: second, title: 'project' },
    })
    expect(secondResult.workspace.workspaceId).not.toBe(firstResult.workspace.workspaceId)
    expect(expectOk(await api.workspace.list(request({}))).items.map(workspace => workspace.path))
      .toEqual([second, first])
  })
})

describe('workspace.insertBefore', () => {
  it('commits the complete order, streams one order frame, and maps unknown ids', async () => {
    const { api, ctx, root } = await harness()
    const first = expectOk(await api.workspace.create(request({ path: stageDir(root, 'first') }))).workspace
    const second = expectOk(await api.workspace.create(request({ path: stageDir(root, 'second') }))).workspace
    const third = expectOk(await api.workspace.create(request({ path: stageDir(root, 'third') }))).workspace

    const abort = new AbortController()
    const listWorkspaces = vi.spyOn(ctx.workspaceRegistry, 'list')
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    expect(listWorkspaces).toHaveBeenCalledTimes(1)
    const changed = nextHostFrame(stream)
    const reordered = expectOk(await api.workspace.insertBefore(request({
      workspaceId: first.workspaceId,
      beforeWorkspaceId: second.workspaceId,
    })))
    expect(reordered.workspaceIds).toEqual([third.workspaceId, first.workspaceId, second.workspaceId])
    expect(await changed).toMatchObject({
      payload: {
        type: 'host/workspace-order-changed',
        workspaceIds: [third.workspaceId, first.workspaceId, second.workspaceId],
      },
    })
    expect(expectOk(await api.workspace.list(request({}))).items.map(item => item.workspaceId))
      .toEqual(reordered.workspaceIds)

    const missingSource = await api.workspace.insertBefore(request({
      workspaceId: 'missing' as WorkspaceId,
    }))
    expect(missingSource.result).toMatchObject({
      ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'missing' } },
    })
    const missingAnchor = await api.workspace.insertBefore(request({
      workspaceId: first.workspaceId,
      beforeWorkspaceId: 'missing-anchor' as WorkspaceId,
    }))
    expect(missingAnchor.result).toMatchObject({
      ok: false, error: { code: 'workspace-not-found', details: { workspaceId: 'missing-anchor' } },
    })
    abort.abort()
  })
})

describe('session creation and Workspace membership', () => {
  it('attaches a preallocated idempotent session while cwd-only sessions stay ungrouped', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    const sessionId = SessionId('session-workspace-preallocated')

    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(ctx.agents.list().filter(agent => agent.id === sessionId)).toHaveLength(1)

    const ungrouped = SessionId('session-cwd-only')
    expectOk(await api.sessions.create(request({ cwd: workspace.path, sessionId: ungrouped })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(ungrouped)

    const conflict = await api.sessions.create(request({ cwd: join(workspace.path, 'other'), sessionId }))
    expect(conflict.result).toMatchObject({
      ok: false,
      error: { code: 'session-conflict', details: { sessionId, existingCwd: workspace.path } },
    })
    const missing = await api.sessions.create(request({
      workspaceId: 'missing-workspace' as WorkspaceId,
      sessionId: SessionId('session-missing-workspace'),
    }))
    expect(missing.result).toMatchObject({ ok: false, error: { code: 'workspace-not-found' } })
  })

  it('retains a published session when attachment fails and repairs it on retry', async () => {
    const { api, ctx, root } = await harness()
    const created = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    const workspace = ctx.workspaceRegistry.list()[0]
    if (workspace === undefined) throw new Error('workspace missing from registry')
    vi.spyOn(workspace, 'attachSession').mockRejectedValueOnce(new Error('simulated write failure'))
    const sessionId = SessionId('session-attach-retry')

    const failed = await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId }))
    expect(failed.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-attach-failed', details: { sessionId, workspaceId: created.workspaceId } },
    })
    expect(ctx.agents.get(sessionId)).toBeDefined()

    expectOk(await api.sessions.create(request({ workspaceId: created.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).items[0]?.sessionIds).toEqual([sessionId])
  })
})

describe('Host Workspace increments', () => {
  it('projects subagent origin in attached summaries and creation increments', async () => {
    const { api, ctx } = await harness()
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const pending = nextHostFrame(stream)
    const childId = SessionId('session-subagent-child')

    ctx.sessions.create(childId, {
      meta: {
        cwd: '/tmp',
        parentSession: SessionId('session-parent'),
        origin: 'subagent',
      },
    })

    expect(await pending).toMatchObject({
      payload: {
        type: 'host/session-added',
        sessionId: childId,
        parentSessionId: 'session-parent',
        origin: 'subagent',
      },
    })
    expect(expectOk(await api.sessions.list(request({}))).items).toContainEqual(
      expect.objectContaining({ sessionId: childId, origin: 'subagent' }),
    )
    abort.abort()
  })

  it('streams committed Workspace and Session increments after empty baselines', async () => {
    const { api, root } = await harness()
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const workspaceIncrement = nextHostFrame(stream)
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'project') }))).workspace
    expect(await workspaceIncrement).toMatchObject({
      payload: { type: 'host/workspace-changed', workspace: { workspaceId: workspace.workspaceId } },
    })

    const sessionId = SessionId('session-streamed-workspace')
    const pending = nextHostFrame(stream)
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    const increments: HostFrame[] = []
    increments.push((await pending).payload)
    while (increments.length < 2) {
      const next = await stream.next()
      if (next.done === true) throw new Error('Host stream ended before both increments')
      increments.push(next.value.payload)
    }
    expect(increments.find(increment => increment.type === 'host/session-added')).toMatchObject({
      // A just-created session has no events: the frame constantly carries blank:true.
      type: 'host/session-added', sessionId, blank: true, cwd: workspace.path,
    })
    const workspaceChanged = increments.find(
      (increment): increment is Extract<HostFrame, { type: 'host/workspace-changed' }> =>
        increment.type === 'host/workspace-changed',
    )
    expect(workspaceChanged?.workspace.sessionIds).toEqual([sessionId])
    abort.abort()
  })

  it('does not publish a Workspace whose registry-order commit fails', async () => {
    const { api, storageDomain, root } = await harness()
    const domain = storageDomain.get('workspace')
    if (domain === undefined) throw new Error('workspace domain is not open')
    vi.spyOn(domain.global, 'set').mockRejectedValueOnce(new Error('simulated registry order failure'))
    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()

    const failed = await api.workspace.create(request({ path: stageDir(root, 'ghost') }))
    expect(failed.result.ok).toBe(false)
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    abort.abort()
    expect(await next).toMatchObject({ done: true })
  })

  it('purges the workspace folder and its live sessions, then streams one removal', async () => {
    const { api, ctx, root, handleDisposals } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'delete-me') }))).workspace
    const sessionId = SessionId('session-purged-with-workspace')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expectOk(await api.workspace.archiveSession(request({ sessionId })))

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const firstRemoval = nextHostFrame(stream)
    expectOk(await api.workspace.delete(request({ workspaceId: workspace.workspaceId })))
    const removals = [(await firstRemoval).payload]
    while (!removals.some(frame => frame.type === 'host/workspace-removed')) {
      removals.push((await nextHostFrame(stream)).payload)
    }
    expect(removals).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'host/session-removed', sessionId }),
      expect.objectContaining({ type: 'host/workspace-removed', workspaceId: workspace.workspaceId }),
    ]))
    expect(expectOk(await api.workspace.list(request({}))).items).toEqual([])
    expect(expectOk(await api.workspace.list(request({}))).archivedSessionIds).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).not.toContain(sessionId)
    expect(handleDisposals).toEqual([sessionId])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(existsSync(workspace.path)).toBe(false)

    const missing = await api.workspace.delete(request({ workspaceId: workspace.workspaceId }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'workspace-not-found', details: { workspaceId: workspace.workspaceId } },
    })

    mkdirSync(workspace.path)
    const reregistered = expectOk(await api.workspace.create(request({ path: workspace.path }))).workspace
    expect(reregistered.workspaceId).not.toBe(workspace.workspaceId)
    expect(reregistered.path).toBe(workspace.path)
    expect(reregistered.sessionIds).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).not.toContain(sessionId)
    abort.abort()
  })

  it('unlinks a workspace path replaced by a symlink without following its target', async () => {
    const { api, root } = await harness()
    const workspacePath = stageDir(root, 'replace-me')
    const target = stageDir(root, 'keep-target')
    const sentinel = join(target, 'valuable.txt')
    writeFileSync(sentinel, 'keep')
    const workspace = expectOk(await api.workspace.create(request({ path: workspacePath }))).workspace
    rmSync(workspacePath, { recursive: true })
    symlinkSync(target, workspacePath, process.platform === 'win32' ? 'junction' : 'dir')

    expectOk(await api.workspace.delete(request({ workspaceId: workspace.workspaceId })))

    expect(existsSync(workspacePath)).toBe(false)
    expect(existsSync(sentinel)).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('serializes workspace deletion after session creation and attachment', async () => {
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'serialized') }))).workspace
    const entity = ctx.workspaceRegistry.get(workspace.workspaceId)
    if (entity === undefined) throw new Error('workspace missing from registry')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const attach = entity.attachSession.bind(entity)
    vi.spyOn(entity, 'attachSession').mockImplementationOnce(async (sessionId) => {
      entered.resolve(undefined)
      await release.promise
      await attach(sessionId)
    })
    const sessionId = SessionId('session-create-delete-race')
    const creation = api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId }))
    await entered.promise
    let deletionSettled = false
    const deletion = api.workspace.delete(request({ workspaceId: workspace.workspaceId }))
      .finally(() => { deletionSettled = true })
    await Promise.resolve()
    expect(deletionSettled).toBe(false)

    release.resolve(undefined)
    expectOk(await creation)
    expectOk(await deletion)
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(existsSync(workspace.path)).toBe(false)
  })

  it('deletes one session lineage while preserving siblings and the workspace directory', async () => {
    const parent = SessionId('session-delete-parent')
    const child = SessionId('session-delete-child')
    const sibling = SessionId('session-delete-sibling')
    const { api, ctx, root, handleDisposals } = await harness(undefined, undefined, {
      parents: new Map([[child, parent]]),
    })
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'keep-me') }))).workspace
    for (const sessionId of [parent, child, sibling]) {
      expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    }
    expectOk(await api.workspace.archiveSession(request({ sessionId: parent })))

    expectOk(await api.workspace.deleteSession(request({ sessionId: parent })))

    expect(handleDisposals).toEqual([child, parent])
    expect(ctx.agents.get(parent)).toBeUndefined()
    expect(ctx.agents.get(child)).toBeUndefined()
    expect(ctx.agents.get(sibling)).toBeDefined()
    expect(existsSync(workspace.path)).toBe(true)
    const listed = expectOk(await api.workspace.list(request({})))
    expect(listed.items[0]?.sessionIds).toEqual([sibling])
    expect(listed.archivedSessionIds).toEqual([])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toEqual([sibling])
    expect((await api.workspace.deleteSession(request({ sessionId: parent }))).result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId: parent } },
    })
  })

  it('includes a descendant published while its parent reaches quiescence', async () => {
    const parent = SessionId('session-delete-racing-parent')
    const child = SessionId('session-delete-racing-child')
    const { api, ctx, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'racing-child') }))).workspace
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId: parent })))
    const parentAgent = ctx.agents.get(parent)
    if (parentAgent === undefined) throw new Error('parent agent missing')
    let published = false
    parentAgent.whenIdle = async () => {
      if (published) return
      published = true
      const session = ctx.sessions.prepare(child, { meta: { cwd: workspace.path, parentSession: parent } })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const childCtx = new Context()
      const childAgent = stubAgent(session, childCtx)
      const unregister = ctx.agents.register(childAgent)
      childCtx.effect(() => () => {
        unregister()
        detach()
      }, 'racing child registration')
    }

    const deleted = expectOk(await api.workspace.deleteSession(request({ sessionId: parent })))

    expect(deleted.deletedSessionIds).toEqual([child, parent])
    expect(ctx.sessions.get(parent)).toBeUndefined()
    expect(ctx.sessions.get(child)).toBeUndefined()
  })

  it('waits for an in-flight cold resume and then removes the published agent', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-')))
    const cwd = stageDir(root, 'cold-resume')
    const sessionId = SessionId('session-cold-resume-race')
    const release = Promise.withResolvers<undefined>()
    const { api, ctx } = await harness(root, undefined, {
      persisted: [{ version: 0, id: sessionId, createdAt: 1, cwd }],
      resumeGate: release.promise,
    })
    const resume = api.sessions.rename(request({ sessionId, title: 'renamed' }))
    let deletionSettled = false
    const deletion = api.workspace.deleteSession(request({ sessionId }))
      .finally(() => { deletionSettled = true })
    await Promise.resolve()
    expect(deletionSettled).toBe(false)

    release.resolve(undefined)
    await resume
    expect(expectOk(await deletion).deletedSessionIds).toEqual([sessionId])
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('broadcasts a permanent cold-session removal to every connected client', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-')))
    const cwd = stageDir(root, 'cold-broadcast')
    const sessionId = SessionId('session-cold-broadcast')
    const { api } = await harness(root, undefined, {
      persisted: [{ version: 0, id: sessionId, createdAt: 1, cwd }],
    })
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = api.events.host(request({}), firstAbort.signal)[Symbol.asyncIterator]()
    const second = api.events.host(request({}), secondAbort.signal)[Symbol.asyncIterator]()
    const nextRemoval = async (stream: AsyncIterator<RpcRequest<HostFrame>>) => {
      for (;;) {
        const frame = await nextHostFrame(stream)
        if (frame.payload.type === 'host/session-removed' && frame.payload.sessionId === sessionId) {
          return frame
        }
      }
    }
    const firstFrame = nextRemoval(first)
    const secondFrame = nextRemoval(second)

    expectOk(await api.workspace.deleteSession(request({ sessionId })))

    const expected = { type: 'host/session-removed', sessionId, deleted: true }
    expect((await firstFrame).payload).toEqual(expected)
    expect((await secondFrame).payload).toEqual(expected)
    firstAbort.abort()
    secondAbort.abort()
  })

  it('keeps persistence retryable when workspace accounting fails first', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-')))
    const cwd = stageDir(root, 'cold-retry')
    const sessionId = SessionId('session-cold-retry')
    const { api, ctx } = await harness(root, undefined, {
      persisted: [{ version: 0, id: sessionId, createdAt: 1, cwd }],
    })
    vi.spyOn(ctx.workspaceRegistry, 'purgeSessions').mockRejectedValueOnce(new Error('storage unavailable'))
    const remove = vi.spyOn(ctx.sessionPersistence, 'delete')

    await expect(api.workspace.deleteSession(request({ sessionId }))).rejects.toThrow('storage unavailable')
    expect(remove).not.toHaveBeenCalled()
    expect(expectOk(await api.workspace.deleteSession(request({ sessionId }))).deletedSessionIds)
      .toEqual([sessionId])
    expect(remove).toHaveBeenCalledWith(sessionId)
  })

  it('commits deletion even when best-effort attachment collection fails', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-apiproxy-workspace-')))
    const cwd = stageDir(root, 'cold-gc')
    const sessionId = SessionId('session-cold-gc')
    const { api, ctx } = await harness(root, undefined, {
      persisted: [{ version: 0, id: sessionId, createdAt: 1, cwd }],
    })
    vi.spyOn(ctx.attachments, 'collectGarbage').mockRejectedValueOnce(new Error('gc unavailable'))

    expect(expectOk(await api.workspace.deleteSession(request({ sessionId }))).deletedSessionIds)
      .toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items).toEqual([])
  })

  it('archives a session into the global set, keeps its accounting, and streams the set once', async () => {
    const { api, root } = await harness()
    const workspace = expectOk(await api.workspace.create(request({ path: stageDir(root, 'archive-home') }))).workspace
    const sessionId = SessionId('session-to-archive')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId })))
    expect(expectOk(await api.workspace.list(request({}))).archivedSessionIds).toEqual([])

    const abort = new AbortController()
    const stream: AsyncIterator<RpcRequest<HostFrame>> =
      api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const changed = nextHostFrame(stream)
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    expect(await changed).toMatchObject({
      payload: { type: 'host/archived-sessions-changed', archivedSessionIds: [sessionId] },
    })

    // Accounting and the session itself are untouched; list re-baselines the set.
    const listed = expectOk(await api.workspace.list(request({})))
    expect(listed.archivedSessionIds).toEqual([sessionId])
    expect(listed.items[0]?.sessionIds).toEqual([sessionId])
    expect(expectOk(await api.sessions.list(request({}))).items.map(item => item.sessionId)).toContain(sessionId)

    // The idempotent repeat emits no second frame: the next observed frame is
    // the workspace-changed of a later attach, not another archive snapshot.
    const after = nextHostFrame(stream)
    expect(expectOk(await api.workspace.archiveSession(request({ sessionId }))).archivedSessionIds)
      .toEqual([sessionId])
    const otherSession = SessionId('session-after-archive')
    expectOk(await api.sessions.create(request({ workspaceId: workspace.workspaceId, sessionId: otherSession })))
    expect((await after).payload.type).not.toBe('host/archived-sessions-changed')

    const missing = await api.workspace.archiveSession(request({ sessionId: SessionId('session-ghost') }))
    expect(missing.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId: 'session-ghost' } },
    })
    abort.abort()
  })
})
