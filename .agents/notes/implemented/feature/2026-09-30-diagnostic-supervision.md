# Agent Note: Diagnostic worker supervision

Status: implemented

## Problem

A parent waiting for diagnostic reports cannot review a worker whose source investigation remains active. Restarting that worker or replacing its assignment loses continuity and changes the authority under which evidence was collected.

## Decision

[Diagnostic runs](../../../../packages/subagent/subagent/README.md#diagnostic-supervision) negotiate `diagnosticSupervisionVersion:1` independently of workflow v1. Core advertises support only with a compatible executor; attachment and admission freeze the same version. Existing admissions keep their tools and behavior.

The parent can return from a timed wait, inspect bounded activity and worker-authored progress, and send instructions through the existing next-step inbox. Guidance retains a parent operation identity and a stable native message identity in durable history. Retrying reconciles the child's inbox and consumed messages before any new enqueue. Acceptance reports queued delivery only after flushing both histories. Accepted closeout prevents further guidance or inference.

Progress is separate from accepted report evidence. Guidance changes neither the assignment nor its source authority, model settings, budgets, or accepted-read provenance. The caller owns the review schedule and the decision to request completion; a checkpoint is not cancellation.

## Alternatives considered

**Force completion at thirty minutes.** Elapsed time alone does not establish adequate evidence. A timed return lets the parent inspect scope and request a specific final check.

**Replace the assignment through legacy continuation.** That changes the frozen assignment and starts a later turn. Native next-step steering preserves the active source call and its authority.

**Treat progress as a report.** Worker-authored status does not have the caller's accepted closeout and publication evidence. It remains explicitly non-evidentiary.

## Consequences

Guidance uses the existing session persistence and inbox rather than a separate scheduler or mailbox. New guidance requires a resident worker; missing residency requires reconciliation instead of automatically restarting inference. Retained delivery status remains inspectable from disk. Report events take precedence over a due checkpoint; a checkpoint leaves the caller's report cursor unchanged, including when publication races persistence.

Native tests cover timed waits, report races, source-call steering, lost acknowledgements, duplicate and cancelled delivery, terminal closeout and unchanged admissions. The runnable headless snapshot covers the parent tools and worker closeout through the Loader.
