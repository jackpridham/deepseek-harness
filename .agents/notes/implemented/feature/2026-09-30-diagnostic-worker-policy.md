# Agent Note: Diagnostic worker admission policy

Status: implemented

## Problem

Effectively unlimited total children allow a new diagnostic run to accumulate more retained worker state than the deployment intends. Concurrency alone does not bound total run work.

## Decision

The subagent owner exposes `diagnosticMaxChildren`, defaulting to fifteen, alongside the existing six-concurrent default. Capability discovery reports the configured ceilings. Core rejects a fresh admission above either ceiling before inference. Existing frozen admissions are checked for identity first and remain recoverable under their original limits. The Vortex executor projects the same core limits in its capability row.

## Validation

Core tests cover defaults, configured ceilings, excessive fresh admission and restoration of an older unlimited admission under a stricter policy. Native executor workflow coverage admits fifteen children in six-concurrent batches and rejects a sixteenth with the retained run limit.

## Alternatives considered

Clamping restored admissions would mutate frozen authority. An executor-only cap would disagree with core discovery and native admission. Neither is used.

## Consequences

The limit applies to newly admitted runs. It does not alter earlier histories or replace bounded history responses, state deduplication and memory-aware persistence. No model or context selection changes.
