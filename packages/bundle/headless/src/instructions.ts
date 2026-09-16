/** Resolve caller-local CLI files into the session instruction input. */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseSessionInstructions } from '@deepseek-ai/dsh-session'
import type { SessionInstructions, InstructionContextSources } from '@deepseek-ai/dsh-session'

/** Optional CLI inputs; repeated files retain command-line order. */
export interface InstructionFlags {
  instructionsFile?: string
  systemPrompt?: string
  systemPromptFile?: string
  prependSystemPromptFile?: string[]
  appendSystemPromptFile?: string[]
  contextSource?: string[]
}

/**
 * Resolve files on the invoking machine. Explicit flags overlay the JSON input once.
 * @param flags - parsed command-line options.
 * @returns literal session configuration, or undefined when no flag was supplied.
 */
export function instructionsFromFlags(flags: InstructionFlags): SessionInstructions | undefined {
  if (Object.values(flags).every(value => value === undefined)) return undefined
  if (flags.systemPrompt !== undefined && flags.systemPromptFile !== undefined) {
    throw new Error('Use --system-prompt or --system-prompt-file, not both')
  }
  const read = (file: string): string => readFileSync(file, 'utf8')
  const input = flags.instructionsFile === undefined
    ? { version: 1 as const } : parseSessionInstructions(JSON.parse(read(flags.instructionsFile)))
  const instructions: SessionInstructions = structuredClone(input)
  const text = flags.systemPromptFile === undefined ? flags.systemPrompt : read(flags.systemPromptFile)
  if (text !== undefined) instructions.systemPrompt = { ...instructions.systemPrompt, base: { mode: 'replace', text } }
  for (const [side, paths] of [['prepend', flags.prependSystemPromptFile], ['append', flags.appendSystemPromptFile]] as const) {
    if (paths === undefined) continue
    const blocks = paths.map((path, index) => ({ id: `${side}-${index + 1}:${basename(path)}`, text: read(path) }))
    instructions.systemPrompt = { ...instructions.systemPrompt, [side]: [...instructions.systemPrompt?.[side] ?? [], ...blocks] }
  }
  for (const entry of flags.contextSource ?? []) {
    const [name, value] = entry.split('=')
    if (!name || !value || entry.split('=').length !== 2) throw new Error('--context-source requires NAME=inherit|off')
    instructions.contextSources = { ...instructions.contextSources, [name]: value } as InstructionContextSources
  }
  return parseSessionInstructions(instructions)
}
