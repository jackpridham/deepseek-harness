/** Session instruction input validation and event-log projection. */
import type { SessionInstructions, SessionInstructionState, SessionEvent } from './types.ts'

/**
 * Validate JSON instructions without trimming text or reordering named blocks.
 * @param value - caller-resolved JSON input.
 * @returns the accepted input, retaining omitted optional fields.
 */
export function parseSessionInstructions(value: unknown): SessionInstructions {
  const object = (input: unknown): Record<string, unknown> => {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Instructions require an object')
    return input as Record<string, unknown>
  }
  const fields = (input: Record<string, unknown>, allowed: string[]): void => {
    for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unknown instruction field: ${key}`)
  }
  const root = object(value)
  fields(root, ['version', 'systemPrompt', 'contextSources'])
  if (root.version !== 1) throw new Error('Unsupported instructions version; expected 1')
  if (root.systemPrompt !== undefined) {
    const prompt = object(root.systemPrompt)
    fields(prompt, ['base', 'prepend', 'append'])
    if (prompt.base !== undefined) {
      const base = object(prompt.base)
      fields(base, base.mode === 'replace' ? ['mode', 'text'] : ['mode'])
      if (base.mode !== 'inherit' && base.mode !== 'replace') throw new Error('System prompt mode must be inherit or replace')
      if (base.mode === 'replace' && typeof base.text !== 'string') throw new Error('Replacement text must be a string')
    }
    const ids = new Set<string>()
    for (const side of ['prepend', 'append']) {
      const blocks = prompt[side]
      if (blocks === undefined) continue
      if (!Array.isArray(blocks)) throw new Error(`${side} must be an array`)
      for (const input of blocks) {
        const block = object(input)
        fields(block, ['id', 'text'])
        if (typeof block.id !== 'string' || !block.id || typeof block.text !== 'string') throw new Error('Instruction blocks require id and text strings')
        if (ids.has(block.id)) throw new Error(`Duplicate instruction block id: ${block.id}`)
        ids.add(block.id)
      }
    }
  }
  if (root.contextSources !== undefined) {
    const sources = object(root.contextSources)
    fields(sources, ['harnessInstructions', 'workspaceInstructions', 'skillCatalog', 'runtimeFacts'])
    for (const value of Object.values(sources)) if (value !== 'inherit' && value !== 'off') throw new Error('Context source must be inherit or off')
  }
  return value as SessionInstructions
}

/**
 * Fold configuration from the complete log, including entries outside the conversation surface.
 * @param events - session events in append order.
 * @returns current revision and exact configured input.
 */
export function sessionInstructionState(events: readonly SessionEvent[]): SessionInstructionState {
  const event = events.findLast(event => event.type === 'session/instructions')
  return event?.type === 'session/instructions' ? event.data : { revision: 0, instructions: null }
}
