// Web e2e scenario: endpoint-owned context and reasoning metadata reaches the
// composer's sibling controls through the real Host/browser composition.
// Selecting never streams, so there is no replay fixture and a stray model
// call fails loud.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

/** Starts the shipped default on this scenario's endpoint-owned reasoning model. */
const OVERLAY = fileURLToPath(new URL('./declared-reasoning.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/declared-reasoning', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/declared-reasoning/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: endpoint model controls reach the composer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let endpoint: Server | undefined

  beforeAll(async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [
          {
            id: 'acme-think',
            name: 'Acme Think',
            context_window: 65_536,
            context_windows: [
              { context_window: 8192, model: 'acme-think--ctx-8192' },
              { context_window: 16_384, model: 'acme-think--ctx-16384' },
              { context_window: 32_768, model: 'acme-think--ctx-32768' },
              { context_window: 49_152, model: 'acme-think--ctx-49152' },
              { context_window: 65_536, model: 'acme-think' },
              { context_window: 81_920, model: 'acme-think--ctx-81920' },
              { context_window: 98_304, model: 'acme-think--ctx-98304' },
              { context_window: 114_688, model: 'acme-think--ctx-114688' },
              { context_window: 122_880, model: 'acme-think--ctx-122880' },
              {
                context_window: 131_072,
                model: 'acme-think--ctx-131072-best-try',
                available: false,
                unavailable_reason: 'Requires resident unload and may fail or crash the model process.',
              },
            ],
            reasoning: {
              format: 'qwen-chat-template',
              efforts: [
                { id: 'off', name: 'Off', wire_value: null },
                { id: 'minimal', name: 'Minimal', wire_value: 'minimal' },
                { id: 'low', name: 'Low', wire_value: 'low' },
                { id: 'medium', name: 'Medium', wire_value: 'medium' },
                { id: 'high', name: 'High', wire_value: 'high' },
                { id: 'xhigh', name: 'XHigh', wire_value: 'xhigh' },
                { id: 'max', name: 'Max', wire_value: 'max' },
              ],
            },
          },
          {
            id: 'acme-other',
            name: 'Acme Other',
            context_window: 262_144,
            context_windows: [{ context_window: 262_144, model: 'acme-other' }],
            reasoning: {
              format: 'qwen-chat-template',
              default_effort: 'minimal',
              efforts: [{ id: 'minimal', name: 'Foreign Minimal', wire_value: 'minimal' }],
            },
          },
          {
            id: 'acme-plain',
            name: 'Acme Plain',
            context_window: 32_768,
            context_windows: [{ context_window: 32_768, model: 'acme-plain' }],
          },
        ] }))
        return
      }
      if (request.url === '/running') {
        response.end(JSON.stringify({ running: [] }))
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
    endpoint = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const { port } = server.address() as AddressInfo
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'acme-gateway': {
          displayName: 'Acme Gateway',
          api: 'openai-completions',
          baseURL: `http://127.0.0.1:${port}/v1`,
          modelsFromEndpoint: true,
          models: [{ id: 'acme-think', contextWindow: 65_536, maxTokens: 4096 }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 800, height: 600 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    if (endpoint !== undefined) {
      const server = endpoint
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    }
  })

  it('keeps context and effort metadata exact to the selected model', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-declared-reasoning'))
    const model = page.getByRole('button', { name: /^选择模型/ })
    await model.waitFor({ timeout: 15_000 })

    const context = page.getByRole('button', { name: /^选择上下文/ })
    await context.click()
    const contexts = page.getByRole('menuitemradio')
    await expect.poll(async () => contexts.count(), { timeout: 10_000 }).toBe(10)
    expect(await contexts.first().textContent()).toContain('8K')
    expect(await contexts.last().textContent()).toContain('128K')
    expect(await page.getByText('256K', { exact: true }).count()).toBe(0)

    const constrained = page.getByRole('menuitemradio', { name: /128K/ })
    expect(await constrained.isEnabled()).toBe(true)
    expect(await constrained.evaluate((row) => {
      const scroller = row.parentElement
      return scroller !== null && scroller.scrollHeight > scroller.clientHeight
    })).toBe(true)
    await constrained.scrollIntoViewIfNeeded()
    const contextMenuBox = await page.getByRole('menu').boundingBox()
    const constrainedBox = await constrained.boundingBox()
    expect((constrainedBox?.y ?? -1)).toBeGreaterThanOrEqual(contextMenuBox?.y ?? 0)
    expect((constrainedBox?.y ?? 0) + (constrainedBox?.height ?? 0))
      .toBeLessThanOrEqual((contextMenuBox?.y ?? 0) + (contextMenuBox?.height ?? 0))
    await constrained.hover()
    await expect.poll(() => page.getByRole('tooltip').textContent())
      .toBe('Requires resident unload and may fail or crash the model process.')
    await constrained.click()
    await expect.poll(() => context.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择上下文，当前 128K')

    // Returning to an ordinary tier proves the constrained override does not
    // leak into a later selection. The component test pins the exact payload.
    await context.click()
    await page.getByRole('menuitemradio', { name: /^64K/ }).click()
    await expect.poll(() => context.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择上下文，当前 64K')

    await page.setViewportSize({ width: 800, height: 420 })
    const effort = page.getByRole('button', { name: /^选择推理等级/ })
    await effort.click()

    const levels = page.getByRole('menuitemradio')
    await expect.poll(async () => levels.allTextContents(), { timeout: 10_000 })
      .toEqual(['Default', 'Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max'])
    expect(await page.getByText('Foreign Minimal', { exact: true }).count()).toBe(0)
    const max = page.getByRole('menuitemradio', { name: 'Max' })
    expect(await max.evaluate((row) => {
      const scroller = row.parentElement
      return scroller !== null && scroller.scrollHeight > scroller.clientHeight
    })).toBe(true)
    await max.scrollIntoViewIfNeeded()
    const effortMenuBox = await page.getByRole('menu').boundingBox()
    const maxBox = await max.boundingBox()
    expect((maxBox?.y ?? -1)).toBeGreaterThanOrEqual(effortMenuBox?.y ?? 0)
    expect((maxBox?.y ?? 0) + (maxBox?.height ?? 0))
      .toBeLessThanOrEqual((effortMenuBox?.y ?? 0) + (effortMenuBox?.height ?? 0))
    const snapshot = await captureStableAria(page, '[role="menu"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    await max.click()
    await expect.poll(
      async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'),
      { timeout: 10_000 },
    ).toContain('reasoningEffort: max')
    await expect.poll(() => effort.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('选择推理等级，当前 Max')

    await page.setViewportSize({ width: 800, height: 600 })
    await model.click()
    await page.getByRole('menuitemradio', { name: 'Acme Plain' }).click()
    const unsupported = page.getByRole('button', { name: /当前模型不支持推理设置/ })
    await expect.poll(() => unsupported.getAttribute('aria-disabled')).toBe('true')
    await unsupported.hover()
    await expect.poll(() => page.getByRole('tooltip').textContent()).toBe('此模型不支持推理等级设置。')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
