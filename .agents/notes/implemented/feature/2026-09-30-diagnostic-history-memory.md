# Agent Note: Diagnostic history memory

Status: implemented

## Problem

Executor polling refreshed every diagnostic child and repeated the complete frozen admission even when no state changed. A retained team00 OWASP root expanded to 604,313,057 JSONL bytes, including 585,006,789 bytes of run state. Reading its immutable history consumed 1,010,467,648 heap bytes before response serialization. Message-count pagination did not bound bookkeeping-only ranges; cold preparations were bounded only by entry count.

## Decision

The subagent owner suppresses unchanged derived state events. JSONL decoding shares repeated immutable strings through a bounded scan-local pool, preserving separate mutable objects and every durable event. The persistence coordinator limits ready-cache retention by serialized-event weight while keeping one oversized source available for reservation. Host history adds a raw-event byte target while retaining complete append-origin message groups and contiguous cursors. These are owner-source changes; the Vortex overlay packages their built artifacts.

No history rewrite, request replay, model change or heap-limit increase is involved. Dispatch limits remain comparison operands rather than allocation sizes. Inspection remains non-mutating; authoritative resume still commits interrupted-turn recovery. Outstanding executor operations require the existing explicit reconciliation protocol.

## Validation

Focused package tests cover unchanged refresh, lossless multibyte history paging, cache eviction and exclusive reservation, and JSONL persistence recovery. The native Vortex fixture reads 175 MiB of repeated retained payloads under a 64 MiB Node heap and checks all event identities. The six-concurrent-worker workflow checks publication, waiting, accepted closeout and cancellation. Live deployment and source-review evidence belongs to the Vortex team00 server report, not this source note.

## Alternatives considered

Raising the Node heap would postpone exhaustion while retaining repeated state writes and unbounded history responses. Rewriting retained histories would alter evidence and operation references. Neither is required for this correction.

## Consequences

A single oversized message group can still exceed the history page target. Explicit workflow cancellation can settle stale native model reservations after native execution drains, including an already incomplete restored run; it retains the original token charge and appends a cancellation reason. Executor dispatch uncertainty remains subject to its receipt and settlement checks and continues to block detachment.
