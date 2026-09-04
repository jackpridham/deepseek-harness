# Agent Note: Direct workspace and session deletion

Status: implemented

## Problem

The Workspace browser exposed permanent Workspace deletion only after a second confirmation dialog, while its Session menu offered archive instead of actual deletion. That made the two neighboring destructive actions inconsistent and left no product path for removing one Session's durable data.

## Decision

Workspace and Session row menus commit their destructive action directly. A failed request leaves the row present and available for retry; a successful state echo removes it. Deleting the selected Session clears the client selection only after the Host confirms deletion.

`workspace.deleteSession` is the single-Session destructive boundary. It selects the requested Session and all lineage descendants, quiesces and disposes their live Agents, deletes their persistence and Session-keyed sidecars child-first, removes every selected id from Workspace accounts and archive state, and collects attachments that have no surviving Session reference. It preserves sibling Sessions and the Workspace filesystem directory.

The existing `workspace.delete` boundary still performs the complete Workspace purge described by the [destructive Workspace purge decision](2026-08-26-destructive-workspace-purge.md). Removing its confirmation changes only the browser interaction; it does not weaken Host path validation, serialization, failure ordering, or data ownership checks.

## Alternatives considered

**Keep the Workspace confirmation dialog.** Rejected for this operator-facing deployment because the row menu already names a destructive action and the additional modal was explicitly removed from the desired flow. The trade-off is a greater chance of accidental deletion.

**Keep archive as the only Session action.** Rejected because archive intentionally retains logs and accounting state, so it cannot satisfy a request to remove a Session. The archive RPC remains available for other consumers.

**Delete only the requested persistence row.** Rejected because live Agent state, lineage descendants, Workspace accounts, Session sidecars, and shared attachments require coordinated ownership-aware cleanup.

## Verification

Host tests exercise cold and live Session deletion, descendant cleanup, missing-id failure, sibling retention, Workspace directory retention, and attachment reference safety. Client-runtime and Workspace browser tests pin success-gated selection clearing, failure retention, direct menu dispatch, and the absence of a confirmation dialog.

## Consequences

The browser provides real Session deletion and a one-click Workspace purge. Both actions are irreversible, and the Workspace action can remove user-created files inside the registered tree. Host-side safety checks remain authoritative, shared attachments survive while referenced, and a rejected request keeps the UI state intact for retry.
