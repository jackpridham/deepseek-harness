# `@deepseek-ai/dsh-headless`

English | [中文](README.zh.md)

The dsh one-shot bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `headless-runner` plugin (config `{task}`, resolved from the injected `headlessStartup` provider). It mounts no Host, HTTP server, Web runtime, or browser plugin.

After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates one fresh persisted Agent through `ctx.agents`, submits the task as an ordinary user message, and waits for quiescence. It flushes the Session before folding the owned durable event interval, writes the last non-empty assistant text to stdout, and requests exit through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) (final `turn/end` completed → 0, otherwise 1). A terminal `error` reason also writes its code and message to stderr; successful runs keep stderr empty. The process opens no listening port. The task text is this app's command line: the ordinary `headless-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), reads the positional argument of `dsh --profile headless "task"`, prints the app's `--help`, and provides `headlessStartup`; the runner injects that service and reads its task from lazy config. A missing or whitespace-only task is rejected before the runner activates.

## Session instruction flags

The headless command accepts `--instructions-file FILE` (version-1 JSON), `--system-prompt TEXT` or `--system-prompt-file FILE`, repeatable `--prepend-system-prompt-file FILE`, repeatable `--append-system-prompt-file FILE`, and repeatable `--context-source NAME=inherit|off`. Files are read as UTF-8 on the invoking machine before session creation. The task positional remains a user message.

The JSON file is the starting configuration. An explicit system flag replaces its base; file blocks extend its respective ordered list; source flags replace the named switches. Generated block ids are `prepend-N:basename` and `append-N:basename`, with N starting at one. Use JSON to supply explicit ids. Text is preserved literally, including whitespace and template-like braces. No flags means no configuration. The runner accepts the same resolved `instructions` object in its Cordis configuration; startup and the API share the session persistence/composition implementation.

## Model Experience

### Session instructions and task

#### What the model sees

The task remains an ordinary user message. Optional instruction flags configure the same session-owned system composition and automatic context sources as the HTTP API. Without those flags, prompts and tools retain the base and headless bundle defaults.

#### Token effect

Caller-authored system blocks are sent once per conversation request. Disabled automatic sources contribute no injected message; explicit reads remain available.

#### KV Cache effect

The accepted system composition remains stable throughout the session. It does not append repeated copies to history.

## Known Limitations and Deferred Work

- **One submitted task only** — the runner has no interactive follow-up surface; it waits through any work the Agent completes before returning to idle and prints the last non-empty assistant message in that interval.
- **`ctx.appExit` is launcher-owned** — booting the headless profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
