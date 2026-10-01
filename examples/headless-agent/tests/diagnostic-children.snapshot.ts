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
  expect(result.stdout).toContain(JSON.stringify({ type: 'diagnostic-worker-capacity', maxChildren: 15, maxConcurrentChildren: 6 }))
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'coordinator' }))
  expect(result.stdout).toContain('Retained diagnostic closeout.')
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it('supervises a busy worker through the assembled application without interrupting its source call', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'diagnostic supervision', tempDirPrefix: 'dsh-supervision-snapshot-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Review admitted source.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: 'supervision' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type?: string; event?: { type: string; data: Record<string, unknown> } })
  expect(rows.filter(row => row.type?.startsWith('supervision-'))).toMatchInlineSnapshot(`
    [
      {
        "active": 1,
        "nextSeq": 0,
        "reason": "checkpoint",
        "type": "supervision-checkpoint",
      },
      {
        "acceptedEvidence": false,
        "resolved": [
          "Assignment scoped",
        ],
        "type": "supervision-progress",
      },
      {
        "duplicate": false,
        "status": "queued",
        "type": "supervision-guidance",
      },
    ]
  `)
  expect(rows.filter(row => row.event?.type === 'tool/call').map(row => row.event!.data.name)).toMatchInlineSnapshot(`
    [
      "dispatch_workers",
      "wait_for_workers",
      "inspect_worker",
      "send_message",
      "closeout_json",
    ]
  `)
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'discovery' }))
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'coordinator' }))
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('renders optional inspection arguments and returns an anchored periodic review through the Loader', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'anchored diagnostic review', tempDirPrefix: 'dsh-review-snapshot-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Review the admitted source.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: 'review' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type?: string })
  expect(rows.filter(row => ['supervision-schema', 'anchored-review'].includes(row.type ?? ''))).toMatchInlineSnapshot(`
    [
      {
        "inspectRequired": [
          "assignmentId",
        ],
        "type": "supervision-schema",
      },
      {
        "due": true,
        "nextReview": 1,
        "type": "anchored-review",
      },
    ]
  `)
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it('recovers worker and coordinator text-only completion in their original turns', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'diagnostic recovery', tempDirPrefix: 'dsh-closeout-recovery-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Review admitted source.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: 'recovery' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type?: string })
  expect(rows.filter(row => row.type === 'closeout-recovery')).toMatchInlineSnapshot(`
    [
      {
        "role": "worker",
        "state": "pending",
        "turn": 1,
        "type": "closeout-recovery",
      },
      {
        "role": "worker",
        "state": "queued",
        "turn": 1,
        "type": "closeout-recovery",
      },
      {
        "role": "coordinator",
        "state": "pending",
        "turn": 1,
        "type": "closeout-recovery",
      },
      {
        "role": "coordinator",
        "state": "queued",
        "turn": 1,
        "type": "closeout-recovery",
      },
    ]
  `)
  expect(result.stdout).toContain('carefully review')
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'discovery' }))
  expect(result.stdout).toContain(JSON.stringify({ type: 'accepted-closeout', role: 'coordinator' }))
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('retrieves complete paged reports in model requests without spill access', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'diagnostic report paging', tempDirPrefix: 'dsh-report-paging-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Read the complete retained worker report.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: 'paging' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type?: string })
  expect(rows.filter(row => row.type === 'report-paging')).toMatchInlineSnapshot(`
    [
      {
        "exact": true,
        "intact": true,
        "multiplePages": true,
        "type": "report-paging",
      },
    ]
  `)
  expect(result.stdout).not.toContain('unexpected-spill')
  expect(result.stdout).not.toContain('Full formatted result stored at')
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)


it('delivers complete inspection scope above the spill limit to the model', async () => {
  const configPath = fileURLToPath(new URL('../diagnostic-children.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({ label: 'complete diagnostic inspection', tempDirPrefix: 'dsh-inspection-',
    configPath, binScript, libBinScript: binScript, binArgs: [configPath, 'Inspect the complete worker investigation.'],
    env: { DSH_TEST_DIAGNOSTIC_WORKFLOW: 'inspection' },
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type?: string })
  expect(rows.filter(row => row.type === 'complete-inspection')).toMatchInlineSnapshot(`
    [
      {
        "bytesAboveOldCap": true,
        "exact": true,
        "type": "complete-inspection",
      },
    ]
  `)
  expect(result.stdout).not.toContain('unexpected-spill')
  expect(result.stdout).not.toContain('Full formatted result stored at')
  expect(result.stdout).not.toContain('"kind":"error"')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
