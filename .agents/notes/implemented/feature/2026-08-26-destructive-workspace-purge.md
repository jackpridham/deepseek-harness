# Agent Note: Destructive Workspace Purge

Status: implemented

## Problem

The browser's Workspace delete action removed only registry metadata. The Workspace directory, live and cold Sessions, transcripts, persistence backups, derived search rows, feedback, projection checkpoints, spill files, and attachments all survived. That contradicted the deployment requirement that deleting a Workspace leave no Harness-owned data associated with it.

## Decision

The workspace.delete RPC is the destructive product boundary. It rejects a filesystem root, takes the selected canonical Workspace path as its ownership boundary, includes nested Workspace paths, and selects every live or persisted Session whose cwd is inside that tree. Seed descendants are included transitively even when their cwd differs.

The Host preflights every live Session, cancels its Agent, waits for quiescence, and disposes the Agent scope. It deletes Sessions child-first through the backend-neutral SessionPersistence.delete operation. JSONL removes the complete Session-owned directory, including transcript siblings and backups; SQLite deletes the Session row transactionally and lets foreign keys cascade events.

An awaited session-persistence/deleting barrier removes Session-keyed projection, feedback, full-text-index, and spill data before the authoritative log commits deletion. The post-commit session-persistence/deleted event remains an observation point. The Workspace registry then forgets the deleted ids from all accounts and archive state.

Before deleting the target logs, the Host records their attachment references. It then scans every surviving log and live Session for retained references. The local content-addressed store removes only target objects absent from that complete retained set; an object shared by a surviving Session remains, and unrelated objects are outside the sweep. Finally, the Host removes the Workspace filesystem tree and deletes nested registrations deepest-first.

## Safety and failure semantics

Sidecar cleanup precedes source deletion, so a sidecar failure leaves the authoritative log available for retry. Workspace registrations are removed last, preserving a retry handle if a later storage or filesystem step fails. Session persistence serializes deletion with writes, refuses live or reserved identities, and frees a successfully deleted id for explicit reuse.

The browser interaction that invokes this boundary and the narrower Session-deletion boundary are owned by the later [direct Workspace and Session deletion decision](2026-09-04-direct-workspace-and-session-deletion.md). Exported downloads or copies moved outside Harness storage are outside this boundary and cannot be recalled.

This decision supersedes the Host/UI behavior in the [metadata-only Workspace deletion note](2026-07-27-workspace-registration-deletion.md). The lower-level WorkspaceRegistry.delete operation intentionally remains metadata-only; only the Host orchestration combines it with Session and filesystem deletion.

## Alternatives considered

**Keep Session logs or the source folder.** Rejected because the required product contract is a complete purge.

**Delete every attachment referenced by a target Session.** Rejected because forked or otherwise surviving Sessions can share a content-addressed object. Marking all surviving logs before collection preserves shared data.

**Remove Workspace metadata first.** Rejected because a later failure would erase the stable retry handle while leaving partial data. Registrations commit last.

## Verification

Shared persistence contracts cover materialized and lazy deletion, unknown and live refusal, id reuse, and commit events. JSONL and zstd tests pin complete directory removal while preserving sibling Sessions; SQLite tests exercise its transactional backend. Focused tests cover reference-aware attachment collection, per-Session spill removal, Workspace account cleanup, live Agent teardown, filesystem removal, and stream convergence.

## Consequences

Workspace deletion is intentionally irreversible and can remove user-created files inside the registered tree. Shared attachments survive until no Session references them. Attachment collection is limited to objects referenced by the purged Sessions, so unrelated storage remains outside the operation.
