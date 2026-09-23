# Agent Note: Preserve terminal events after fetch cancellation

Status: implemented

## Problem

Node fetch can annotate the object supplied to `AbortController.abort()` with a non-enumerable `stack` property before rejecting with that same object. Persisting `AbortSignal.reason` directly then fails the session's lossless JSON validation. The driver reaches idle after reporting the append error, but its durable turn remains open and automation waiting for `turn/end` cannot advance.

## Decision

AgentLoop projects the declared `AgentCancelCause` fields into a fresh object when recording an aborted turn: every cause retains `kind`, and a hook cause also retains its `reason` text. Live cancellation continues to pass the original cause through the signal. The session's lossless JSON validation remains strict.

## Alternatives considered

**Permit non-enumerable properties in session data.** This would weaken lossless persistence for every event to accommodate one mutable runtime value. The cancellation owner knows which fields belong in durable history.

**Treat idle as a terminal event.** Idle describes current activity and does not repair the missing durable turn outcome. Consumers need the explicit cancellation cause and ordered terminal event.

## Consequences

Fetch's runtime annotations cannot prevent an otherwise valid cancellation from closing its turn. Cancellation causes remain a declared typed record; adding a cause with additional durable fields requires updating this projection.

## Verification

The agent-loop cancellation tests issue a real HTTP fetch against a local server, cancel it with user and hook causes, and require exactly one `turn/end` before idle with no agent error. Both cases reproduce the non-JSON append failure without the projection. Existing cancellation cases cover parent and disposal causes and queue behavior.
