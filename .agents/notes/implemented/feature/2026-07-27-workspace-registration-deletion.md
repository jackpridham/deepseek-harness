# Agent Note: Workspace Registration Deletion

Status: implemented

English | [中文](2026-07-27-workspace-registration-deletion.zh.md)

## Problem

A Workspace registers an existing code directory so the GUI can name it and order its Sessions. That record does not say that Harness created or owns the directory, and the Session log is an independent persistence object. Treating the row's Delete action as recursive source deletion or Session deletion would destroy data outside the record's ownership boundary.

The existing visual-only menu row also left deletion semantics undefined across durable order, the Workspace table, Host streams, concurrent browser tabs, reconnect baselines, and a list request racing the mutation.

## Decision

`ctx.workspaceRegistry.delete(id)` deletes only the Workspace registration: its id leaves durable `workspaceIds`, its `workspaces` table row and entity-cache entry disappear, and its ordered `sessionIds` account disappears with that row. It never calls filesystem removal or `SessionPersistence`; the directory, every user file, every live Session, and every persisted Session log remain. Because sidebar grouping is the complement of all surviving Workspace accounts, those Sessions immediately appear under Ungrouped, including the current Session.

Unknown ids return `false` at the domain contract. The Host's public `workspace.delete({ workspaceId })` composes this metadata commit as the final step of the separately owned [destructive Workspace purge](2026-08-26-destructive-workspace-purge.md); it maps an unknown registration to `workspace-not-found`. `workspace.list` remains the reconnect baseline.

## Durable commit and publication

Registry operations serialize create and delete. Deletion first writes the Workspace order without the id, then removes the entity from the cache, then deletes the table row. The table deletion is the notification commit point: the package invariant accepts it only after the cache stopped publishing the entity, and the Host emits `host/workspace-removed` only from that committed deletion. A table-write failure restores the cache and prior durable order; no removal frame is published.

The Host stream keeps its committed-id set through the preceding global-order write and removes the id only on the table deletion. Create rollback therefore emits no false removal, while every connected tab receives exactly the id needed to delete its projection.

Create and delete write a durable `pendingMutation` before their record/order pair can diverge. Startup completes only the operation named by that marker and clears it; an orphan row alone does not identify which operation was interrupted. Unmarked order/table divergence therefore retains the registry's fail-loud corruption behavior. A deletion whose table write committed but marker cleanup failed still reports success—the requested state and removal frame are already committed—and the next startup clears that marker idempotently.

## Client convergence

`WorkspaceManager` treats both `host/workspace-changed` and `host/workspace-removed` as ordered deltas replayed over an in-flight `workspace.list` response. A successful unary delete removes the row immediately instead of waiting for its own stream echo. Removal is idempotent, and a process-local tombstone rejects late changed frames or stale baseline rows for the never-reused Workspace id. A reconnect still refreshes from `workspace.list`; Session state is never pruned by a Workspace delta.

The browser's direct destructive interaction is owned by the later [Workspace and Session deletion decision](2026-09-04-direct-workspace-and-session-deletion.md). Registry removal still converges through the unary result and committed stream frame.

## Product boundary

`WorkspaceRegistry.delete` remains a metadata-only domain operation. The Host does not expose it as a metadata-only browser action: `workspace.delete` first purges the owned filesystem and Sessions, then commits this registry removal. `workspace.deleteSession` uses `WorkspaceRegistry.purgeSessions` without deleting the Workspace registration or directory. The destructive orchestration and direct row interactions belong to the linked later decisions rather than this lower-level registry contract.

## Alternatives considered

**Cascade-delete Sessions inside `WorkspaceRegistry.delete`.** Rejected because the registry record does not own Session persistence. The Host-level purge performs the coordinated lifecycle, descendant, sidecar, attachment, and filesystem work before invoking this metadata operation.

**Move the folder to Trash.** Rejected because the record cannot prove directory ownership. A future destructive filesystem action must be separately named, separately confirmed, and enforce explicit safety boundaries.

**Delete the table row and repair order later.** Rejected because a crash or write failure would leave an initialized registry whose order and table disagree. The registry updates both under one serialized operation and restores the prior order on table failure.

**Delete every unreferenced row at startup.** Rejected because the same shape can come from unexplained order corruption; silently discarding it could lose Workspace metadata and Session accounting. Recovery requires the explicit pending marker written by the owning mutation.

**Refetch both lists after success.** Rejected because the committed removal frame plus immediate unary echo is sufficient, preserves the current Session object, and avoids turning a local mutation into two list requests. Reconnect baselines remain the repair path.

## Verification

Workspace package tests pin successful metadata-only deletion, same-path re-registration, unknown-id idempotence, table-failure rollback, explicit-marker restart recovery, unexplained-corruption rejection, and cache/table invariant behavior. Host and client tests pin `workspace-not-found`, the committed `host/workspace-removed` frame, unary direct echo, duplicate removal, late changed frames, and deletion racing an in-flight baseline. Destructive filesystem and Session behavior is verified by the later purge decisions.

## Consequences

The metadata operation is reversible by registering the same surviving directory again with a fresh id, although its prior manual Session order is gone. The public Host deletion is intentionally not reversible because its wider ownership boundary removes the directory and Sessions first. Keeping those responsibilities separate prevents the registry primitive from silently acquiring filesystem or persistence authority.
