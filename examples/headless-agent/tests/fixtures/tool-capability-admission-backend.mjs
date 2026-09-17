/** Deterministic explicit tool-capability refusal through the production Pi-AI adapter. */

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'

export const name = 'tool-capability-admission-backend'
export const inject = ['llm']

/** Register the explicit-negative model capability used by the snapshot. */
export function apply(ctx) {
  const resolved = resolveProfiles({
    'deepseek-official': {
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:1',
      models: [{ id: 'deepseek-v4-flash' }],
    },
  })
  const profiles = new Map([...resolved].map(([provider, profile]) => [provider, {
    ...profile,
    modelStates: new Map([['deepseek-v4-flash', {
      selectable: true,
      active: false,
      supportsTools: false,
    }]]),
  }]))
  ctx.llm.registerAdapter(['deepseek-official'], new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('snapshot-key'),
  }))
}
