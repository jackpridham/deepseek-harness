import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('./fixtures/session-policy/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/session-policy/root.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('session policy assembled snapshot', () => {
  it('attests and composes a no-tool, no-runtime-context session through the shipped Web Loader tree', async () => {
    const result = await runLoaderSmoke({
      label: 'session policy snapshot',
      tempDirPrefix: 'session-policy-snapshot-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
    })

    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchInlineSnapshot(`
      {
        "created": {
          "result": {
            "ok": true,
            "value": {
              "policy": {
                "attestation": {
                  "isolated": true,
                },
                "id": "test-isolated-v1",
              },
              "sessionId": "session-policy-snapshot",
            },
          },
          "rpcId": "session-create",
        },
        "header": {
          "cwd": null,
          "sessionPolicy": "test-isolated-v1",
        },
        "policy": {
          "result": {
            "ok": true,
            "value": {
              "attestation": {
                "isolated": true,
              },
              "id": "test-isolated-v1",
            },
          },
          "rpcId": "session-policy",
        },
        "prompt": {
          "contexts": [],
          "rendered": "Test policy prompt.",
          "tools": [],
        },
        "runtimeContextEvaluations": 0,
        "sessionPolicies": [
          "test-isolated-v1",
        ],
        "toolSchemas": [],
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
