# Agent Note: Diagnostic output-aware compaction

Status: implemented

## Problem

The web profile disables the host compactor while diagnostic policy disables presets. Consequently diagnostic roots and native children lack the standard preset’s isolated compactor. Token-meter header matching also includes maxTokens and its default marker, so an output-only change discards useful provider input calibration. These are verified source defects. The supplied validator history reports a 198705-to-163400 estimate decrease and provider context rejection; attributing that exact deployment sequence still requires matching deployed artifacts and raw generation events. No historical session was inspected or mutated for this implementation.

## Decision

Enable the existing host compactor for diagnostic policy alone. Keep presets, host tools and ambient instructions disabled. Admission and restoration fail if the service is unavailable. Preserve diagnostic output allowances at every supported size through the existing fully assembled request check, compaction and remeasurement; irreducible requests fail explicitly. Ordinary sessions keep their existing fallback. Output-only header changes retain provider calibration; genuine input/model/configuration changes remain distinct.

Compaction inherits admitted model/context/reasoning, respects the assignment output ceiling, checks instructions/tools, and participates in cancellation and run-wide accounting. Existing bounded provider-overflow recovery retries only the rejected model request. Central history and accepted evidence remain intact; checkpoints are neither new evidence nor closeout.

## Alternatives considered

Enabling the general preset would widen diagnostic composition. A larger fixed safety margin would hide calibration loss. A fixed 65536-token trigger would fail other context/output combinations. New loop, meter or compaction owners are unnecessary.

## Consequences

Web deployments must include the updated compactor, loop, token meter, subagent owner and web bundle patch together. No caller change is required. Default pressure is 0.65; dynamic request admission remains authoritative regardless of that setting. Summary output is separately capped at 8192 and at the assignment ceiling. Persisted assignments are unchanged; restored sessions adopt the installed compactor configuration.

## Testing and limits

Deterministic service tests cover roots, discovery and validation, restoration, large tool results, rejected closeout arguments, dynamic output allowances (4096, 8192, 32768, 65536), contexts 32768 and 262144, history preservation, budget charges, unavailable service, irreducible input, truncation, summary failure and cancellation. Existing compactor regressions exercise no-reduction and bounded overflow recovery. The runnable headless snapshot includes a native child summary. These are mocked local checks, not provider/runtime acceptance. Token estimation remains heuristic when no reusable provider anchor exists; provider framing/tokenizer differences require separately authorized effective-request validation.
