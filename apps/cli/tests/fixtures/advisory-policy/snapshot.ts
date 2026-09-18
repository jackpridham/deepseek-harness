import { fileURLToPath } from 'node:url'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

const rootConfigPath = process.argv[2]
if (rootConfigPath === undefined) throw new Error('advisory policy snapshot requires a root config path')
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const webPatchPath = fileURLToPath(new URL('../../../../../packages/bundle/web-app/cordis.patch.yml', import.meta.url))
const ctx = await boot('advisory-policy-snapshot', rootConfigPath, [
  ...loadOverlayPatches('advisory-policy-snapshot', basePatchPath),
  ...loadOverlayPatches('advisory-policy-snapshot', webPatchPath),
  { id: 'webserver', disabled: true },
  { id: 'web-runtime', disabled: true },
  { id: 'session-telemetry-otel', disabled: true },
  { id: 'modules', disabled: true },
  { id: 'connection', disabled: true },
  { id: 'client-hmr', disabled: true },
  { id: 'directory-picker', disabled: true },
], (bootCtx) => {
  provideCmdline(bootCtx, { args: [], exit: () => {} })
  // The gateway injects this optional UI seam but this snapshot never invokes
  // a picker; a local inert provider avoids starting a host interaction.
  bootCtx.provide('directoryPicker', {} as never)
})

try {
  let runtimeContextEvaluations = 0
  ctx.systemPrompt.context({
    name: 'snapshot-host-context',
    order: 1,
    text: () => {
      runtimeContextEvaluations += 1
      return 'must not be sent'
    },
  })
  const sessionId = SessionId('advisory-policy-snapshot')
  const created = await ctx.apiProxy.sessions.create({
    rpcId: RpcId('advisory-create'),
    payload: { sessionId, sessionMode: 'advisory' },
  })
  if (!created.result.ok) throw new Error(created.result.error.message)
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('advisory session was not attached')
  const policy = await ctx.apiProxy.sessions.getToolPolicy({
    rpcId: RpcId('advisory-policy'), payload: { sessionId },
  })
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  const described = await ctx.apiProxy.host.describe({ rpcId: RpcId('advisory-describe'), payload: {} })
  if (!described.result.ok) throw new Error(described.result.error.message)
  process.stdout.write(`${JSON.stringify({
    advisoryPolicyVersions: described.result.value.advisoryPolicyVersions,
    created,
    policy,
    header: { sessionMode: agent.session.header.sessionMode, cwd: agent.session.header.cwd ?? null },
    prompt: { contexts: assembly.contexts, tools: assembly.tools, rendered: renderPrompt(assembly) },
    toolSchemas: ctx.tools.schemas(agent),
    runtimeContextEvaluations,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
