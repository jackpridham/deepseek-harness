# Agent Note: Automatic worker switching for chat settings

Status: implemented

## Problem

A shared worker can differ from a chat's saved context, mode, or serving options. Rejecting the next turn forces the user to resolve a mismatch that already has a requested configuration.

## Decision

The pi-ai adapter routes mismatches to the requested catalog configuration and sends the scheduler's switch-worker header with the freshly observed worker identity. Matching settings reuse the loaded route, regardless of a stale saved identity. A stopped worker uses ordinary cold admission without an obsolete identity precondition.

The scheduler owns draining, capacity checks, and replacement. Best-try admission remains explicit; a concurrent worker change or capacity rejection remains a visible failure, without an unbounded retry. This supersedes the manual-dispatch requirement described in [loaded worker context recovery](2026-09-16-loaded-worker-context-recovery.md); explicit adoption and notice dismissal remain available.

## Alternatives considered

**Automatically adopt loaded settings.** This would change the chat's requested context or serving behavior instead of honoring it.

**Unload and reload from the client.** Separate operations would duplicate scheduler lifecycle handling and weaken atomic admission checks.

## Consequences

Ordinary turns can trigger a scheduler-controlled worker replacement. Concurrent chats requesting different configurations can incur reload delays. Existing capacity and active-request protections remain enforced by the scheduler; automatic switching does not imply successful GPU admission.

## Testing

Focused adapter checks cover smaller and larger contexts, mode and option changes, matching settings with a stale identity, stopped workers, and capacity rejection. An assembled web-app snapshot checks the requested route, observed identity, switch header, and successful response using a local provider fixture.

The seven focused regressions and assembled snapshot pass, as do the affected package TypeScript compilation and bundle build. The adjacent suites retain two failures in unchanged catalog metadata expectations. Repository-wide documentation checks report existing catalog, JSDoc, formatting, and model-experience issues; full validation is not green. No deployment or live inference acceptance is included.
