# Agent Note: Loaded worker context recovery

Status: implemented

## Problem

A restored session can request a context tier that requires best-try admission while a smaller worker is ready. Validating the saved tier before adopting loaded settings prevents recovery. The composer conflict notice also obstructs input without a dismissal action.

## Decision

Explicit adoption verifies the observed worker identity and substitutes its context, mode, and options before request validation. It clears the saved best-try override. Session history remains intact; the existing request admission and compaction paths handle the smaller allowance.

The notice can be dismissed without changing session preferences or loading a worker. Reopening a selector exposes the unresolved notice again; changed preferences or worker facts produce a new notice.

## Alternatives considered

**Enable best-try automatically for the saved tier.** This would authorize an unwanted larger worker and would not recover the intended smaller-context selection.

**Clear the conflict when dismissed.** Dismissal is a presentation choice, not acceptance of different worker settings.

## Consequences

Adoption can recover an existing session without raising context. Worker changes require a refreshed selection, and dismissal alone does not change settings. [Automatic worker switching](2026-09-16-automatic-worker-switch.md) resolves the mismatch during subsequent inference admission. No host deployment is implied by the source change.

## Validation

Focused regressions cover adoption from an unavailable 256K preference to a ready 64K worker with and without a saved best-try override, rejection of a stale worker identity, and notice dismissal without mutation. The assembled browser snapshot covers dismissal and reopening. The affected TypeScript projects compile; Agent Note format, relative documentation links, and whitespace checks pass.

The broader GUI run reports 22 failures in model/output expectations, onboarding, session forks, and other existing coverage. The full web build stops at test mocks missing `configureInstructions` and `getInstructions`; the focused assembled snapshot passes using rebuilt client bundles. Focused lint also reports existing assertions and void-expression callbacks in the touched production files. These broader checks are not green, and no deployment or live inference acceptance is recorded.
