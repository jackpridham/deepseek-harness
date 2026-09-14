/** External Vortex row controls load only through this fixture's browser boot manifest. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

interface SelectedModel {
  provider: string
  model: string
  contextWindow?: number
}

interface HostModelReader {
  sessions: {
    models(request: { rpcId: unknown; payload: { sessionId: SessionId } }): Promise<{
      result: { ok: boolean; value: { current: SelectedModel | null } }
    }>
  }
}

const PLUGIN_ROOT = process.env.VORTEX_PLUGIN_ROOT
const PLUGIN_ID = '@vortex/dsh-image-command'
const PLUGIN_PATH = PLUGIN_ROOT === undefined ? undefined : join(PLUGIN_ROOT, 'lib/client.js')

interface RuntimeState {
  state: 'idle' | 'draining' | 'held'
  running?: 'idle' | 'loading' | 'ready'
}

/** This test is opt-in: the DSH source tree never gains an external plugin dependency. */
describe.skipIf(PLUGIN_PATH === undefined)('web e2e: external Vortex model controls', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let bundle = ''
  let runtime: RuntimeState = { state: 'held' }
  let loadPolls = 0
  let drainPolls = 0
  let rejectFirstDrain = true
  const actions: Array<Record<string, unknown>> = []

  const state = () => ({ model: 'resident', targets: ['resident'], context: 262_144, ...runtime })
  const write = (
    res: { writeHead: (code: number, headers?: Record<string, string>) => void; end: (body: string) => void },
    status: number,
    body: unknown,
  ) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const bodyOf = async (req: AsyncIterable<Buffer>): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }

  beforeAll(async () => {
    bundle = await readFile(PLUGIN_PATH!, 'utf8')
    scaffold = await launchWebScaffold()
    const revision = createHash('sha1').update(bundle).digest('hex').slice(0, 12)
    // Test-only route: it serves a prebuilt external client bundle without adding a DSH package edge.
    scaffold.ctx.webServer.register({ kind: 'exact', path: '/__fixture/vortex-model-controls/client.js', handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(bundle)
    } })
    scaffold.ctx.webServer.register({ kind: 'exact', path: '/api/vortex/models/capabilities', handler: (_req, res) => {
      write(res, 200, { provider: 'inf01', lease: 'code', mediaEnabled: false, mediaModels: [] })
    } })
    scaffold.ctx.webServer.register({ kind: 'exact', path: '/api/vortex/models/status', handler: (req, res) => {
      const query = new URL(req.url ?? '', scaffold.baseUrl).searchParams
      if (query.get('provider') !== 'inf01' || query.get('model') !== 'resident') return write(res, 404, { error: 'unknown model' })
      if (runtime.running === 'loading' && ++loadPolls > 1) runtime = { state: 'idle', running: 'ready' }
      if (runtime.state === 'draining' && ++drainPolls > 1) runtime = { state: 'held' }
      write(res, 200, state())
    } })
    scaffold.ctx.webServer.register({ kind: 'exact', path: '/api/vortex/models/action', handler: async (req, res) => {
      const action = await bodyOf(req)
      actions.push(action)
      if (action.action === 'drain' && rejectFirstDrain) {
        rejectFirstDrain = false
        return write(res, 503, { error: 'drain refused' })
      }
      if (action.action === 'load') runtime = { state: 'idle', running: 'loading' }
      else if (action.action === 'drain') runtime = { state: 'draining', running: 'ready' }
      else return write(res, 400, { error: 'unknown action' })
      write(res, 200, state())
    } })
    // The normal client-modules tap runs first. This script executes before the shell module and
    // adds a fixture-only entry, whose dependency list mirrors the external package declaration.
    scaffold.ctx.webServer.tapIndex(html => html.replace('</head>', `<script>window.__DSH_BOOT__.entries.push(${JSON.stringify({
      id: PLUGIN_ID,
      url: `/__fixture/vortex-model-controls/client.js?rev=${revision}`,
      rev: revision,
      inject: [
        '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-commands', '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-model-selection', '@deepseek-ai/dsh-client-ui-tool',
      ],
    }).replaceAll('<', '\\u003c')});</script></head>`))
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'origin-gateway': { displayName: 'Origin', api: 'openai-completions', baseURL: 'https://origin.invalid/v1', models: [{ id: 'origin-large', contextWindow: 65_536 }] },
        inf01: { displayName: 'INF01', api: 'openai-completions', baseURL: 'https://inf01.invalid/v1', models: [{ id: 'resident', name: 'Resident', contextWindow: 131_072 }] },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    await page.addInitScript(() => { window.confirm = () => true })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads, drains, retries and preserves the chat selection through the actual external row plugin', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    const row = dialog.getByText('Resident', { exact: true }).locator('xpath=ancestor::li')
    await row.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /^选择模型/ }).click()
    await dialog.getByRole('menuitemradio', { name: 'Resident', exact: true }).click()
    await expect.poll(async () => {
      const sessionId = scaffold.ctx.sessions.list()[0]?.id
      if (sessionId === undefined) return undefined
      const response = await (scaffold.ctx.get('apiProxy') as unknown as HostModelReader).sessions.models({ rpcId: 'plugin-controls-current' as never, payload: { sessionId: SessionId(sessionId) } })
      return response.result.ok ? response.result.value.current : undefined
    }).toMatchObject({ provider: 'inf01', model: 'resident', contextWindow: 131_072 })

    const controls = row.getByLabel('Runtime controls for resident')
    await controls.getByText('Off', { exact: false }).waitFor()
    await controls.getByRole('button', { name: 'Load', exact: true }).click()
    await controls.getByText('Loading', { exact: false }).waitFor()
    await expect.poll(() => controls.getByText('Ready', { exact: false }).count(), { timeout: 8_000 }).toBeGreaterThan(0)
    expect(actions[0]).toMatchObject({ provider: 'inf01', model: 'resident', context: 131_072, action: 'load', bestTryContext: false })

    await controls.getByRole('button', { name: 'Unload', exact: true }).click()
    await expect.poll(() => controls.getByRole('alert').textContent()).toMatch(/drain refused/)
    await controls.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect.poll(() => controls.getByRole('status').textContent()).toContain('Ready')
    await controls.getByRole('button', { name: 'Unload', exact: true }).click()
    await controls.getByText('Waiting for active requests', { exact: false }).waitFor()
    await expect.poll(() => controls.getByText('Off', { exact: false }).count(), { timeout: 8_000 }).toBeGreaterThan(0)

    const sessionId = scaffold.ctx.sessions.list()[0]?.id
    const response = await (scaffold.ctx.get('apiProxy') as unknown as HostModelReader).sessions.models({ rpcId: 'plugin-controls-preserved' as never, payload: { sessionId: SessionId(sessionId!) } })
    expect(response.result.ok && response.result.value.current).toMatchObject({ provider: 'inf01', model: 'resident', contextWindow: 131_072 })
    await page.screenshot({ path: '/tmp/harness-settings-review.png', fullPage: true })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
