# Agent Note: Same-turn diagnostic closeout recovery

Status: implemented

## Problem

A diagnostic worker or coordinator can finish in prose, including JSON, without an accepted durable domain report. Rejected submissions also leave the model able to finish normally. Caller retries through ordinary child prompting would violate prepared-assignment authority and risk losing the accumulated investigation.

## Decision

The jointly negotiated `diagnosticCloseoutRecoveryVersion:1` uses the existing turn-stopping listener and next-step inbox. The listener now receives the proposed `TurnEndReason`, so only normal completion qualifies; other stop reasons retain their handling. Executor commitment gating includes rejected closeouts for opted-in bindings: a fast subsequent prose response cannot outrun receipt persistence.

One session-local intent records a stable reminder/message identity, assignment, turn and triggering step before steering. The reminder asks the model to reconcile its preceding investigation, correct recorded schema rejections and submit the complete assigned report. It preserves source/evidence authority and model configuration. The same request-budget helper guards both recovery admission and ordinary model dispatch; no new allowance is granted.

Inbox/message events establish delivery. Duplicate callbacks at the same step and uncertain persistence acknowledgements never enqueue another message. If a delivered reminder is followed by another normal finish, the worker records missing-report state and the root receives a durable native-wait update. Accepted report receipts remain the sole acceptance authority; delivery, compliance, acceptance and caller publication stay separate.

## Alternatives considered

Ordinary subagent prompting would bypass prepared-assignment authority. A replacement worker or summary reconstruction would lose the accumulated context. Repeated reminders would hide a missing artifact behind unbounded inference, so one reminder is the complete automatic recovery allowance.

## Consequences

Recovery is opt-in for new admissions and stays frozen through restoration. It cannot repair already-ended legacy turns, malformed submissions while the model remains active, interrupted source calls or insufficient inference allowance. Intent-only recovery without established delivery remains uncertain rather than being replayed. Existing checkpoint continuation restrictions apply.

## Evidence

Focused worker/coordinator tests exercise ordinary prose and JSON, rejected submissions, pending acceptance, duplicate callbacks, interrupted persistence, uncertain delivery, reminder exhaustion, excluded stop reasons and budget denial. A real Loader snapshot and a built core/executor workflow cover same-turn recovery and terminal accepted closeout. Deterministic tests do not establish live model compliance or end-to-end OWASP acceptance.
