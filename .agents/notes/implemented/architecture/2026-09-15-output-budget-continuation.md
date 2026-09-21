# Agent Note: Managed model selection, lifecycle, and output continuation

Status: implemented

## Problem

A request could reserve an output cap without checking the assembled input against its selected context, and a capped response ended the turn even when it held useful partial work.

## Decision

Image pressure uses the attachment's pixel dimensions with a coarse 16×16 spatial-patch estimate, not encoded file bytes treated as base64 text. Pricing transport bytes made a retained image alone exhaust a 128K context while repeated compaction could only shrink the older checkpoint. The estimate remains model-independent; actual vision tokenization and provider overflow handling remain authoritative.

The agent loop measures the actual durable surface with its provisional header before dispatch, reserves the configured safety margin, and resolves isolated preset compaction through the agent-presets service, falling back to the ordinary scoped service. Pressure and output admission share range selection, which declines a candidate made only of existing compaction checkpoints. It gives the compaction provider bounded opportunities to reduce new history, then sends the smaller effective cap or fails without dispatch. `output/budget` records that admission.

Summary truncation has its own bounded recovery and typed `COMPACTION_SUMMARY_TRUNCATED` failure. Output admission catches only that failure, remeasures the preserved surface, and sends a reduced response allowance if space remains. Cancellation takes precedence, and an exhausted context preserves the specific summary diagnostic. This behavior applies to resumed sessions with old failed compaction records without changing their event format or replacing incomplete checkpoints.

A completed checkpoint that is not smaller than its selected region has a separate `COMPACTION_NO_REDUCTION` failure. Output-budget compaction catches only that typed rejection after cancellation checks and returns the last committed reduction, if any. The shrink guard and failed lifecycle record stay intact; unchanged history is not retried within that admission. The loop still measures the full request before deciding whether a smaller output allowance fits. Retention and tool-pair balancing can leave a small historical prefix even when the complete request nearly fills context, so rejection of that checkpoint alone does not prove that the next model request is unsafe.

A capped response retains text and reasoning, drops every tool call from the assembled message, and appends one durable continuation input. At most three additional requests are scheduled per turn. A repeated or empty text/reasoning result, continuation error, direct `AgentOptions.maxTokens` cap, or exhausted continuation bound ends recovery. `output/continuation` records the outcome. A successful continuation is a completed turn; an unrecovered cap remains `max-tokens`.

## Alternatives considered

- **Dropping the net-reduction guard or swallowing all compaction failures** — can expand history or conceal provider, lifecycle and cancellation failures. Only a completed non-reducing candidate is declined by output-budget compaction.
- **A browser-only continue action** — would not recover goals, SDK children, or reconnecting sessions.
- **Executing a capped tool call** — partial arguments are not safe actions.
- **Treating all numeric caps as hard caller limits** — session output selection also resolves to a numeric request cap and must remain continuable.

## Managed model contract

The shared picker puts selectable models first and exposes catalog modes and output limits. Selection is durable before acknowledgment; fresh requests adopt verified loaded context, mode and generation before budgeting. An intentional configuration change requires an explicit worker switch; the accepted generation is saved only after readiness. Native model operations and ordinary inference share backend request IDs and lifecycle facts. Ordinary chat alone surfaces those facts as conversation lifecycle rows; title and compaction retain backend correlation without extra rows. Stream settlement immediately records its completed, failed, or cancelled outcome before optional backend enrichment. The provider preserves structured terminal capacity errors through a maintained pi-ai patch.

## Validation

Keyless runnable headless snapshots cover non-reducing compaction with available output space and with exhausted context; package regressions preserve history, cancellation and unrelated failures. Live inference and deployment acceptance remain separate.

## Consequences

The session log exposes the selected request allowance after runtime reduction and continuation history to both SDK transports without a second protocol. A direct child or SDK request that supplies `maxTokens` remains a hard per-request bound. The fixed estimator is intentionally conservative through `outputSafetyMargin`; increase it only when provider overflow evidence shows it is insufficient.
