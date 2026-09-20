# Agent Note: Anchor provider usage after entered input

Status: implemented

## Problem

The agent logs `step/start` before entering the current user input. Anchoring provider usage to the surface at that earlier event counts entered input twice: once in reported input usage and again as heuristic growth. Long tool turns can therefore fail output admission even though the selected context has room for the tool result and final reply.

## Decision

The [token meter](../../../../packages/llm/token-meter/README.md) anchors successful usage against the complete input preceding the assistant message, plus the provider output reconstructed from its cited chunks. Step boundaries validate event ordering rather than capture input size. The same input point applies to the estimated fallback. Signed durable-output rewrites, later tool results, canonical-header invalidation, and conservative low-usage fallback remain unchanged.

## Alternatives considered

**Increase context or bypass output admission.** Neither corrects the duplicate accounting, and disabling admission would remove protection against real overflow.

**Change the displayed pressure or use it for admission.** The display's provider sample does not contain the duplicate. It is an approximate independent projection, not the complete request measurement used by compaction and output admission.

**Add another output mode.** Auto already resolves to the model's configured request default and follows normal context-aware admission. A new mode would not repair the shared measurement service.

## Consequences

Long requests retain room for tool-result replay without weakening context checks. Unit coverage exercises entered input, replay, subsequent steps, missing usage, and conservative estimates. The real headless composition snapshot performs a native bash call and final reply under an automatic output default with input large enough to reproduce the duplicate-accounting failure. Model-native tokenization remains outside the fixed heuristic's guarantees.
