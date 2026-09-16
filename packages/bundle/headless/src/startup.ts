/**
 * The one-shot app's command-line provider: it parses the task positional and
 * `--help`, then publishes {@link HEADLESS_STARTUP_SERVICE}. The runner is an
 * ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { instructionsFromFlags, type InstructionFlags } from './instructions.ts'
import type { SessionInstructions } from '@deepseek-ai/dsh-session'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the one-shot runner. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
  /** Resolved caller-local text, using the ordinary session API input. */
  instructions?: SessionInstructions
}

/**
 * This app's command: the task positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .option('--instructions-file <file>', 'session instruction JSON input')
    .option('--system-prompt <text>', 'replace the inherited system prompt')
    .option('--system-prompt-file <file>', 'replace with local UTF-8 file contents')
    .option('--prepend-system-prompt-file <file>', 'prepend a literal block (repeatable)', (value: string, previous: string[] = []) => [...previous, value])
    .option('--append-system-prompt-file <file>', 'append a literal block (repeatable)', (value: string, previous: string[] = []) => [...previous, value])
    .option('--context-source <name=inherit|off>', 'control an automatic context source (repeatable)', (value: string, previous: string[] = []) => [...previous, value])
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"     answer one task and exit
`)
}

/**
 * Parse and provide the one-shot task as an ordinary Cordis service. The
 * command's action publishes the task; a missing or whitespace-only task is a
 * usage error, so on rejection (and on `--help`) nothing is provided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = headlessCommand()
  program.action(() => {
    const task = program.args.join(' ')
    if (task.trim() === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
    const instructions = instructionsFromFlags(program.opts<InstructionFlags>())
    ctx.provide(HEADLESS_STARTUP_SERVICE, { task, ...instructions === undefined ? {} : { instructions } } satisfies HeadlessStartupValues)
  })
  parseCmdline(ctx, program)
}
