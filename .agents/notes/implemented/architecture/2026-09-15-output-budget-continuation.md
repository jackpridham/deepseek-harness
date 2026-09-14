# Agent Note: Managed model selection, lifecycle, and output continuation

Status: implemented

## Problem

A request could reserve an output cap without checking the assembled input against its selected context, and a capped response ended the turn even when it held useful partial work.

## Decision

The agent loop measures the actual durable surface with its provisional header before dispatch, reserves the configured safety margin, and resolves isolated preset compaction through the agent-presets service, falling back to the ordinary scoped service. It gives that compaction provider one opportunity to reduce history, then sends the smaller effective cap or fails without dispatch. `output/budget` records that admission.

A capped response retains text and reasoning, drops every tool call from the assembled message, and appends one durable continuation input. At most three additional requests are scheduled per turn. A repeated or empty text/reasoning result, continuation error, direct `AgentOptions.maxTokens` cap, or exhausted continuation bound ends recovery. `output/continuation` records the outcome. A successful continuation is a completed turn; an unrecovered cap remains `max-tokens`.

## Alternatives considered

- **A browser-only continue action** — would not recover goals, SDK children, or reconnecting sessions.
- **Executing a capped tool call** — partial arguments are not safe actions.
- **Treating all numeric caps as hard caller limits** — session output selection also resolves to a numeric request cap and must remain continuable.

## Managed model contract

The shared picker puts selectable models first and exposes catalog modes and output limits. Selection is durable before acknowledgment; fresh requests adopt verified loaded context, mode and generation before budgeting. An intentional configuration change requires an explicit worker switch; the accepted generation is saved only after readiness. Native model operations and ordinary inference share backend request IDs and lifecycle facts. Ordinary chat alone surfaces those facts as conversation lifecycle rows; title and compaction retain backend correlation without extra rows. Stream settlement immediately records its completed, failed, or cancelled outcome before optional backend enrichment. The provider preserves structured terminal capacity errors through a maintained pi-ai patch.

## Validation

Validation for this development deployment consists of source review, TypeScript and bundle builds, and installation integrity checks. Browser, CLI functional and inference acceptance are reserved for the user.

## Consequences

The session log exposes the selected request allowance after runtime reduction and continuation history to both SDK transports without a second protocol. A direct child or SDK request that supplies `maxTokens` remains a hard per-request bound. The fixed estimator is intentionally conservative through `outputSafetyMargin`; increase it only when provider overflow evidence shows it is insufficient.
