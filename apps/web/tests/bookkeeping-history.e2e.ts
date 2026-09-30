import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SEED_ID = 'bookkeeping-history-web-e2e'
const GOLDEN = fileURLToPath(new URL('./snapshots/bookkeeping-history/ui.expected.md', import.meta.url))

/** Cold retained log with invisible ranges larger than the host page target. */
function seed(): string {
  const lines = [JSON.stringify({ type: 'session', version: 0, id: '{{sessionId}}', createdAt: 1784974100000, cwd: '{{cwd}}/workspace' })]
  let seq = 0
  const append = (event: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ ...event, seq, time: 1784974100000 + seq++ }))
  }
  for (let turn = 1; turn <= 2; turn++) {
    append({ type: 'turn/start', data: { turn } })
    append({ type: 'user/message', surfaceOp: 'append', data: { content: [{ type: 'text', text: `parent question ${turn}` }], source: { kind: 'user' } } })
    append({ type: 'step/start', data: { turn, step: 1 } })
    append({ type: 'assistant/message', surfaceOp: 'append', sourceEventSeqs: [], data: {
      turn, step: 1, message: { id: `00000000-0000-4000-8000-${String(turn).padStart(12, '0')}`,
        role: 'assistant', content: [{ type: 'text', text: `parent response ${turn}` }],
        source: { kind: 'model', provider: 'snapshot', model: 'snapshot-replier' } },
    } })
    append({ type: 'step/end', data: { turn, step: 1 } })
    for (let i = 0; i < 12; i++) append({ type: 'paging-fixture/bookkeeping', ignorable: true, data: { payload: 'x'.repeat(256 * 1024) } })
    append({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return `${lines.join('\n')}\n`
}

describe('web: bounded bookkeeping history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, seed(), SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })
  it('opens to visible content and loads older content across hidden pages', async () => {
    onTestFailed(async () => { console.log(await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)) })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await expect.poll(() => page.getByText('parent response 2', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.getByText('parent question 1', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Load earlier' }).click()
    await expect.poll(() => page.getByText('parent question 1', { exact: true }).count(), { timeout: 15_000 }).toBe(1)
    expect(await page.getByText('parent response 1', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('button', { name: 'Load earlier' }).count()).toBe(0)
    const aria = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)).split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(GOLDEN, aria, webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
