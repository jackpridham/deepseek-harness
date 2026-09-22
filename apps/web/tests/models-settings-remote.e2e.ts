/** Trusted remote Models settings reads the host catalog without a settings document. */
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: remote Models settings catalog', () => {
  let catalogServer: Server
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    catalogServer = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.url === '/v1/models' ? { data: [
        { id: 'older', name: 'Older Chat', description: 'General conversation and summaries.', release_date: '2024-07-23', url: 'https://huggingface.co/example/older' },
        { id: 'unknown', name: 'Undated Chat', description: 'No verified public release date.', release_date: null, url: 'javascript:alert(1)' },
        { id: 'newest', name: 'Newer Image', description: 'Image generation with readable text.', release_date: '2026-01-20', url: 'https://huggingface.co/example/newest', selectable: false },
      ] } : { running: [], workers: [] }))
    })
    await new Promise<void>(resolve => catalogServer.listen(0, '127.0.0.1', resolve))
    const address = catalogServer.address()
    if (address === null || typeof address === 'string') throw new Error('catalog server did not bind')
    scaffold = await launchWebScaffold({ remoteAuthority: 'remote.localhost' })
    await scaffold.ctx.settings.update(settingsNamespace('llm-pi-ai'), { providers: {
      research: { displayName: 'Research catalog', api: 'openai-completions', baseURL: `http://127.0.0.1:${address.port}/v1`, modelsFromEndpoint: true },
    } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await new Promise<void>((resolve, reject) => catalogServer?.close((error) => { if (error) reject(error); else resolve() }))
  })

  it('shows the session-independent catalog and keeps provider editing unavailable', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await dialog.getByRole('region', { name: 'Model catalog' }).waitFor({ timeout: 10_000 })
    await dialog.getByText('DeepSeek-V4-Flash', { exact: true }).waitFor()
    await dialog.getByText('The settings document is read-only in this deployment.').waitFor()
    expect(await dialog.getByRole('button', { name: 'Add provider' }).isDisabled()).toBe(true)
    const selector = 'section:has(> h4:text-is("Research catalog"))'
    const catalog = dialog.locator(selector)
    await catalog.getByText('Image generation with readable text.', { exact: true }).waitFor()
    expect(await catalog.locator('li').evaluateAll(rows => rows.map(row => row.querySelector('a, span')?.textContent)))
      .toEqual(['Newer Image', 'Older Chat', 'Undated Chat'])
    expect(await catalog.getByRole('link', { name: 'Newer Image', exact: true }).getAttribute('href')).toBe('https://huggingface.co/example/newest')
    expect(await catalog.getByRole('link', { name: 'Newer Image', exact: true }).getAttribute('target')).toBe('_blank')
    expect(await catalog.getByRole('link', { name: 'Undated Chat', exact: true }).count()).toBe(0)
    expect(await catalog.locator('time').allTextContents()).toEqual(['2026-01-20', '2024-07-23'])
    await compareOrRefreshGolden(
      fileURLToPath(new URL('./snapshots/model-catalog-metadata/ui.expected.md', import.meta.url)),
      await captureStableAria(page, selector, scaffold.workspaceCwd), MODE,
    )
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
