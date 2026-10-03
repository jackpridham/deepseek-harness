import { defineConfig } from 'tsdown'

/** Keep target validation available in immutable runtime overlays without host dependency installation. */
export default defineConfig({
  deps: { alwaysBundle: ['@deepseek-ai/dsh-subagent/diagnostic-schema', /^ajv(?:\/|$)/, /^ajv-formats(?:\/|$)/] },
})
