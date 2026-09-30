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
  expect(result.stdout).toContain(JSON.stringify({ type: 'child-title', title: 'OWASP discovery child' }))
  expect(result.stdout).toContain('Child accepted.')
  expect(result.stdout).toContain(JSON.stringify({ type: 'diagnostic-summary', contextWindow: 262144, maxTokens: 8192 }))
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('returns a failed worker update when a workflow child ends with prose', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'diagnostic missing closeout', tempDirPrefix: 'dsh-workflow-prose-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Review admitted source.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: 'prose' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { event?: { type: string; data: Record<string, unknown> } })
  expect(events.filter(row => row.event?.type === 'tool/call').map(row => row.event!.data.name)).toMatchInlineSnapshot(`
    [
      "dispatch_workers",
      "wait_for_workers",
      "closeout_json",
    ]
  `)
  expect(result.stdout).toContain(JSON.stringify({ type: 'diagnostic-child-outcome', state: 'failed', quiescent: true }))
  expect(result.stdout).toContain('ended without a completed report (failed)')
  expect(result.stdout).not.toContain(JSON.stringify({ type: 'accepted-closeout', role: 'discovery' }))
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'coordinator' }))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it('dispatches a scoped worker and ends both assignments on accepted closeout', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'diagnostic workflow', tempDirPrefix: 'dsh-workflow-snapshot-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Review admitted source.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: '1' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { event?: { type: string; data: Record<string, unknown> } })
  expect(events.filter(row => row.event?.type === 'tool/call').map(row => row.event!.data.name)).toMatchInlineSnapshot(`
    [
      "dispatch_workers",
      "closeout_json",
    ]
  `)
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'discovery' }))
  expect(result.stdout).toContain(JSON.stringify({ type: 'diagnostic-worker-capacity', maxChildren: Number.MAX_SAFE_INTEGER, maxConcurrentChildren: 6 }))
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'coordinator' }))
  expect(result.stdout).toContain('Retained diagnostic closeout.')
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
