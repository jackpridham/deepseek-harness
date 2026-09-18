import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/advisory-policy/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/advisory-policy/root.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('advisory policy assembled snapshot', () => {
  it('attests and composes a no-tool, no-runtime-context session through the shipped Web Loader tree', async () => {
    const result = await runLoaderSmoke({
      label: 'advisory policy snapshot',
      tempDirPrefix: 'advisory-policy-snapshot-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
    })

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
      {
        "advisoryPolicyVersions": [
          1,
        ],
        "created": {
          "result": {
            "ok": true,
            "value": {
              "sessionId": "advisory-policy-snapshot",
              "toolPolicy": {
                "automaticHostContextEnabled": false,
                "executorEnabled": false,
                "mode": "advisory",
                "tools": [],
                "version": 1,
                "workspaceEnabled": false,
              },
            },
          },
          "rpcId": "advisory-create",
        },
        "header": {
          "cwd": null,
          "sessionMode": "advisory",
        },
        "policy": {
          "result": {
            "ok": true,
            "value": {
              "automaticHostContextEnabled": false,
              "executorEnabled": false,
              "mode": "advisory",
              "tools": [],
              "version": 1,
              "workspaceEnabled": false,
            },
          },
          "rpcId": "advisory-policy",
        },
        "prompt": {
          "contexts": [],
          "rendered": "You are an advisory reviewer. Review supplied evidence and report findings without tools or host context.",
          "tools": [],
        },
        "runtimeContextEvaluations": 0,
        "toolSchemas": [],
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
