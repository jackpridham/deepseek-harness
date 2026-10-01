# Agent Note: Diagnostic pages survive tool-result formatting

Status: implemented

## Problem

Native diagnostic pages were bounded by an approximately 2 MiB transport envelope. The normal spill policy separately limited the rendered text to 50,000 UTF-8 bytes, so a complete-looking report response could lose its middle while retaining `nextOffset:null`. Policy-bound diagnostic agents could not retrieve the backend spill file. Worker-update paging shared the same larger budget.

## Decision

The Tools service exposes the scoped `tools/inline-text-budget` waterfall through `inlineTextBudget(scope)`. Active spill policies contribute their existing validated byte cap, combined by minimum and removed with their owning fiber. Paging measures both complete rendered text and the original escaped transport envelope. No formatter is bypassed and no global limit changes.

Report reads retain UTF-16 offsets, immutable packet contents, report identity and digest. A final-page fit check avoids rejecting a complete response that fits because its null continuation is shorter than a numeric offset. Worker-update measurement includes the actual supervision/review wrapper; its cursor does not advance across an unreturned event. Metadata or an indivisible update that cannot fit produces an explicit failure.

## Alternatives considered

A second hard-coded 50,000-byte constant would drift from configured or scoped policies. Exempting reports from spilling would allow much larger model inputs. Truncation followed by spill-file retrieval violates the caller-owned source access policy. A separate report-transfer API would duplicate existing immutable paging.

## Consequences

No diagnostic wire change or caller migration is required. Page sizes follow the active formatter configuration, while report identity and canonical contents remain unchanged. Existing admissions and model settings are untouched. The spill formatter has no independent character or line ceiling; compact JSON escapes embedded newlines and byte measurement includes Unicode and escaping.

## Evidence

TDD reproduces truncation through the actual tool registry and spill formatter before the fix, for report and wait pages. Boundary, Unicode, escaped-string, multiline-content and multi-page tests reconstruct the exact canonical packet from model-visible text, retaining retries and identities. A runnable Loader fixture verifies pages in accumulated model requests. Built runtime/plugin integration retains publication validation and cross-run authorization. These deterministic checks do not constitute live report retrieval or OWASP acceptance.
