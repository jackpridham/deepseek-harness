/** Settings uses the active chat's existing ModelDirectory rather than a synthetic session. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./default-model.overlay.yml', import.meta.url))

describe.skipIf(MODE === 'record')('web e2e: Models settings selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), {
      providers: {
        'origin-gateway': {
          displayName: 'Origin Gateway', api: 'openai-completions', baseURL: 'https://origin.example/v1',
          models: [{ id: 'origin-large', name: 'Origin Large', contextWindow: 65_536 }],
        },
        'settings-gateway': {
          displayName: 'Settings Gateway', api: 'openai-completions', baseURL: 'https://settings.example/v1',
          models: [{ id: 'settings-chat', name: 'Settings Chat', contextWindow: 131_072 }],
        },
      },
    })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('selects the catalog model through the active chat directory', async () => {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.getByRole('button', { name: '模型', exact: true }).click()
    const picker = dialog.getByRole('button', { name: /^选择模型/ })
    await picker.waitFor({ timeout: 10_000 })
    await picker.click()
    await dialog.getByRole('menuitemradio', { name: 'Settings Chat', exact: true }).click()
    await expect.poll(async () => {
      const sessionId = scaffold.ctx.sessions.list()[0]?.id
      if (sessionId === undefined) return undefined
      const response = await scaffold.ctx.apiProxy.sessions.models({
        rpcId: 'models-settings-selection' as never,
        payload: { sessionId: SessionId(sessionId) },
      })
      return response.result.ok ? response.result.value.current : undefined
    }).toMatchObject({ provider: 'settings-gateway', model: 'settings-chat', contextWindow: 131_072 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
