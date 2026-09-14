/** Trusted remote Models settings reads the host catalog without a settings document. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: remote Models settings catalog', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ remoteAuthority: 'remote.localhost' })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows the session-independent catalog and keeps provider editing unavailable', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await dialog.getByRole('region', { name: 'Model catalog' }).waitFor({ timeout: 10_000 })
    await dialog.getByText('DeepSeek-V4-Flash', { exact: true }).waitFor()
    await dialog.getByText('The settings document is read-only in this deployment.').waitFor()
    expect(await dialog.getByRole('button', { name: 'Add provider' }).isDisabled()).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
