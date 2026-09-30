# Agent Note: Chat traversal across bookkeeping history

Status: implemented

## Problem

Byte-bounded history responses can contain only diagnostic bookkeeping. The browser previously loaded one raw page per action, leaving an active parent blank while its workers remained visible. Retained parent messages could sit behind dozens of invisible pages.

## Decision

The Session owner follows contiguous older pages until a registered Chat node becomes visible. Initial opening and gap repair use the same traversal when their loaded window has no Chat nodes. “Load earlier” stops at a node before its original cursor, so newly arriving live content cannot prematurely finish the historical traversal. Reconnect generation checks reject stale responses. Empty, failed and discontinuous pages stop traversal without speculative cursor advancement.

Host page bounds, durable events, source operations and model execution are unchanged. The loaded raw window remains available to registered conversation definitions; this is not a total browser-retention limit.

## Validation

Session tests cover long bookkeeping gaps, live arrivals, reconnect races, empty pages and retry after transport failure. A keyless real-Host Chromium scenario seeds two conversation turns separated and followed by multi-megabyte invisible records, then verifies opening and loading older content through the built client and captures its rendered transcript.

## Alternatives considered

Removing the Host byte bound would restore oversized responses and the allocation failure. Requiring repeated manual clicks exposes transport page boundaries as empty UI actions. Filtering durable diagnostic events from the shared RPC would break caller history and reconciliation.

## Consequences

Long invisible ranges require several sequential history requests. All loaded raw events still occupy browser memory; a future filtered presentation transport would need explicit sequence and reconstruction contracts. This change does not restart cancelled reviews.
