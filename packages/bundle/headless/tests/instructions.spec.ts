import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { instructionsFromFlags } from '../src/instructions.ts'

it('resolves literal local files and ordered blocks into one declarative input', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-instruction-flags-'))
  try {
    writeFileSync(join(root, 'role.md'), '  ROLE {{literal}}\n')
    writeFileSync(join(root, 'a.md'), 'A\n')
    writeFileSync(join(root, 'b.md'), 'B\n')
    writeFileSync(join(root, 'input.json'), JSON.stringify({ version: 1, systemPrompt: { prepend: [{ id: 'policy', text: 'BEFORE' }] }, contextSources: { skillCatalog: 'off' } }))
    const flags = { instructionsFile: join(root, 'input.json'), systemPromptFile: join(root, 'role.md'), appendSystemPromptFile: [join(root, 'a.md'), join(root, 'b.md')], contextSource: ['workspaceInstructions=off', 'runtimeFacts=inherit'] }
    expect(instructionsFromFlags(flags)).toEqual({ version: 1, systemPrompt: { base: { mode: 'replace', text: '  ROLE {{literal}}\n' }, prepend: [{ id: 'policy', text: 'BEFORE' }], append: [{ id: 'append-1:a.md', text: 'A\n' }, { id: 'append-2:b.md', text: 'B\n' }] }, contextSources: { skillCatalog: 'off', workspaceInstructions: 'off', runtimeFacts: 'inherit' } })
    expect(instructionsFromFlags(flags)).toEqual(instructionsFromFlags(flags))
    expect(instructionsFromFlags({})).toBeUndefined()
    expect(instructionsFromFlags({ systemPrompt: '' })?.systemPrompt?.base).toEqual({ mode: 'replace', text: '' })
    expect(() => instructionsFromFlags({ systemPrompt: 'a', systemPromptFile: join(root, 'a.md') })).toThrow('not both')
    expect(() => instructionsFromFlags({ contextSource: ['typo=off'] })).toThrow('Unknown instruction field')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
