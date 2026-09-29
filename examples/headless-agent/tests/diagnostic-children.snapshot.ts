/** Native diagnostic child dispatch through the real Loader and headless driver. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('runs a prepared diagnostic child through the assembled application', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'diagnostic children', tempDirPrefix: 'dsh-diagnostic-snapshot-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Review the prepared assignment.'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { event?: { type: string; data: Record<string, unknown> } })
  const assignmentStates = events.filter(row => row.event?.type === 'diagnostic/assignment-state').map(row => row.event!.data.state)
  expect(assignmentStates).toMatchInlineSnapshot(`
    [
      "dispatched",
      "running",
    ]
  `)
  expect(result.stdout).toContain('Child accepted.')
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
