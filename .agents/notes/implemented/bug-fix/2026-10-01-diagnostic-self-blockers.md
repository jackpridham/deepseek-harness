# Agent Note: Remove diagnostic report and supervision self-blockers

Status: implemented

## Problem

A display formatter could truncate an accepted closeout acknowledgement, causing publication to reject the durable report. Independent report, inspection and source-count ceilings blocked valid local diagnostic work. Output accounting charged every completed request its maximum allowance even when actual usage was small.

## Decision

Diagnostic report acceptance and publication use durable executor receipts and native call identities. Report transport and publication have no total payload ceiling; inspection returns complete scope and event details. The report and inspection tools bypass spill substitution. Report retrieval retains exact continuation paging without limiting total report size. The HTTP carrier exempts only the publication RPC; the deployment-owned proxy and executor endpoint carry complete reports.

Diagnostic source arrays have no maximum count. Canonical encoding accepts finite JSON numbers with ECMAScript number spelling; existing integer digests are unchanged. Request settlement records actual output usage only after completed terminal inference. In-flight and uncertain requests retain their reservations, and accounting rebuilds from the latest durable record for each request identity.

## Alternatives considered

**Larger fixed limits** merely move the report and inspection failures to another input size. Complete local reports and inspection are the operator's explicit requirement.

**Charging requested tokens forever** overstates completed work. Releasing unknown reservations instead would undercount interrupted inference, so only terminal usage settles the charge.

## Consequences

Large reports and complete inspections consume memory and model context proportional to their contents. Provider context/output allowances still apply. Source identities, frozen assignments, accepted evidence, retry identities and terminal closeout remain authoritative. Legacy report-size fields remain readable but do not impose a ceiling; callers omit the removed inspect_worker maxEvents field.

Focused regressions cover large report acceptance, publication independent of display JSON, complete inspection through the actual formatter, finite numeric digests, multiple sources and durable token settlement. Runnable Loader checks verify model-visible inspection and exact paged report reconstruction. The earlier [paging decision](2026-10-01-diagnostic-report-paging.md) continues to govern page offsets and reconstruction; total report and inspection caps are superseded here.
