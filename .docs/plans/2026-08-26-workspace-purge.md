# Workspace Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `$executing-plans` for inline execution. This is one lifecycle milestone whose persistence, filesystem, sidecar, and UI changes must be reviewed together; steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed Workspace deletion permanently remove the selected Workspace tree, every associated Session and Session-owned artifact, all Harness sidecars, and attachment objects no surviving Session references.

**Architecture:** Add a backend-neutral `SessionPersistence.delete()` primitive serialized by `PersistenceCoordinator`, with JSONL-directory and SQLite-row implementations. The Host Workspace RPC owns the destructive orchestration: preflight the complete nested-Workspace and Session-descendant set, quiesce live Agents, delete Sessions bottom-up, remove the Workspace filesystem tree safely, delete the Workspace registrations, and then garbage-collect unreferenced attachment objects. Session-deletion events let derived stores remove sidecars without coupling persistence to each consumer.

**Tech Stack:** TypeScript, Cordis services/events, Node filesystem APIs, SQLite, React, Vitest, Playwright, pnpm documentation gates.

---

### Task 1: Session persistence deletion primitive

**Files:**
- Modify: `packages/session/session-persistence/src/index.ts`
- Modify: `packages/session/session-persistence/src/coordinator.ts`
- Modify: `packages/session/session-persistence/src/preparations.ts`
- Modify: `packages/session/session-persistence/tests/contract.ts`
- Modify: `packages/session/session-persistence/tests/coordinator-contract.ts`
- Modify: `packages/session/session-persistence/tests/persistence.spec.ts`

- [ ] **Step 1: Write failing shared contract tests**

Add cases proving materialized deletion, lazy-intent deletion, unknown-id rejection, live/reserved refusal before mutation, serialization behind an append, id reuse, and exactly one post-commit event:

```ts
await persistence.delete(id)
await expect(persistence.load(id)).rejects.toThrow(`session "${id}" not found`)
expect(deleted).toEqual([id])
```

- [ ] **Step 2: Run the focused coordinator tests and confirm failure**

Run: `pnpm exec vitest run packages/session/session-persistence/tests/persistence.spec.ts`

Expected: failure because `SessionPersistence.delete` and the backend hook do not exist.

- [ ] **Step 3: Add the service and backend contracts**

Add this public method and the post-commit event declaration:

```ts
abstract delete(id: SessionId): Promise<void>

'session-persistence/deleted'(id: SessionId): void
```

Add a backend hook returning whether durable storage contained the id:

```ts
deleteStored(id: SessionId): Promise<boolean>
```

- [ ] **Step 4: Implement coordinator deletion**

Queue deletion on the per-id chain, reject live or exclusively prepared identities before mutation, cancel an unmaterialized create intent without touching storage, remove coordinator state only after the backend commits, invalidate reusable preparations, and emit the deletion event after commit.

- [ ] **Step 5: Run the focused coordinator tests**

Run: `pnpm exec vitest run packages/session/session-persistence/tests/persistence.spec.ts`

Expected: pass.

### Task 2: JSONL and SQLite durable deletion

**Files:**
- Modify: `packages/session/session-persistence-jsonl/src/index.ts`
- Modify: `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts`
- Modify: `packages/session/session-persistence-jsonl/tests/zstd.spec.ts`
- Create: `packages/session/session-persistence-sqlite/resources/sql/delete-session.sql`
- Modify: `packages/session/session-persistence-sqlite/src/store.ts`
- Modify: `packages/session/session-persistence-sqlite/src/index.ts`
- Modify: `packages/session/session-persistence-sqlite/tests/sqlite.spec.ts`

- [ ] **Step 1: Add failing backend tests**

For both JSONL encodings, place extra files and directories beside the transcript, delete the Session, and assert the complete session-owned directory is absent while sibling Sessions remain. For SQLite, assert the metadata row and cascading event rows disappear in one transaction.

- [ ] **Step 2: Implement JSONL directory deletion**

Resolve the identity through normal lookup, validate that the transcript belongs beneath the configured root, refuse the root/project directory itself, and remove the real session-owned directory recursively. If the target has become link-shaped, unlink only the link.

- [ ] **Step 3: Implement SQLite transaction deletion**

Execute a schema-validated `BEGIN IMMEDIATE` transaction and delete the Session metadata row; the foreign-key cascade owns event rows. Return `false` for zero changed rows.

- [ ] **Step 4: Run backend tests**

Run: `pnpm exec vitest run packages/session/session-persistence-jsonl/tests/jsonl.spec.ts packages/session/session-persistence-jsonl/tests/zstd.spec.ts packages/session/session-persistence-sqlite/tests/sqlite.spec.ts`

Expected: pass.

### Task 3: Derived-data and attachment cleanup

**Files:**
- Modify: `packages/attachment/attachment/src/index.ts`
- Modify: `packages/attachment/attachment-local/src/index.ts`
- Modify: `packages/attachment/attachment-local/src/store.ts`
- Modify: `packages/attachment/attachment-local/tests/store.spec.ts`
- Modify: `packages/session/session-projection-cache/src/index.ts`
- Modify: `packages/session/session-projection-cache/tests/*.spec.ts`
- Modify: `packages/workspace/workspace/src/index.ts`
- Modify: `packages/workspace/workspace/tests/workspace.spec.ts`
- Modify other Session-keyed sidecar consumers discovered by `rg`.

- [ ] **Step 1: Write failing cleanup tests**

Assert that a deletion event removes the Session from Workspace accounts and archive state, removes projection/feedback rows, and that attachment collection removes only objects absent from the retained reference set.

- [ ] **Step 2: Add attachment garbage collection**

Add a provider-neutral operation accepting retained attachment ids. The local provider validates content-addressed filenames, removes unretained regular objects, prunes empty buckets, never follows links, and leaves retained or concurrently absent objects alone.

- [ ] **Step 3: Subscribe derived stores to deletion**

Use effect-owned `session-persistence/deleted` listeners. Each listener deletes only records owned by the deleted Session and completes after its domain write commits.

- [ ] **Step 4: Run focused sidecar and attachment tests**

Run the owning Vitest files selected from the changed packages.

Expected: pass.

### Task 4: Host Workspace purge orchestration

**Files:**
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`
- Modify: `packages/host/apiproxy/src/api/workspace.ts` only if the response contract needs additional committed counts.

- [ ] **Step 1: Replace the retention test with failing purge tests**

Create a selected Workspace, a nested registered Workspace, root/child Sessions, archived Sessions, Session artifact sidecars, attachments shared and unshared with a surviving Session, and user files. Assert preflight failure changes nothing; success leaves none of the selected tree's registrations, files, Sessions, logs, sidecars, or unshared attachments.

- [ ] **Step 2: Implement a complete preflight**

Collect selected and nested Workspace paths, every accounted/live/persisted Session in those paths, and the transitive Session descendant closure. Reject filesystem roots and any live Session without a matching Agent lifecycle before cancelling or deleting anything.

- [ ] **Step 3: Quiesce and delete Sessions**

Cancel every target Agent with `{ kind: 'disposed' }`, await idle and fiber disposal, verify no target remains live, and call `SessionPersistence.delete()` child-first. Already-absent descendants are skipped from the fresh persistence listing so crash retries converge.

- [ ] **Step 4: Remove the filesystem and registrations**

Delete the selected real directory without following a replacement link, then delete nested Workspace records deepest-first and the selected record last. Run a retained-reference scan over surviving Session logs and collect unreferenced attachment objects.

- [ ] **Step 5: Run Host tests**

Run: `pnpm exec vitest run packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`

Expected: pass.

### Task 5: Destructive confirmation and assembled browser behavior

**Files:**
- Modify: `packages/client/ui-workspace/src/client/locales.ts`
- Modify: `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`
- Modify: `apps/web/tests/workspace-management.e2e.ts`
- Modify keyless replay fixtures only through the owning snapshot command.

- [ ] **Step 1: Update component expectations first**

Pin visible copy that explicitly names permanent deletion of the directory, nested Workspaces, Sessions, logs, generated files, and unshared attachments, while preserving the existing pending/failure interaction.

- [ ] **Step 2: Update the UI copy**

Keep the single confirmation action and danger styling; change only the truthful consequences.

- [ ] **Step 3: Update the assembled scenario**

Assert the Workspace, current Session, user file, and JSONL directory remain absent after reload, and that a surviving Workspace and shared attachment remain usable.

- [ ] **Step 4: Run GUI and replay checks**

Run: `pnpm run test:gui`

Run: `DSH_SNAPSHOT=replay pnpm run test:web`

Expected: pass, with intentional fixture refresh performed only if the replay owner reports a changed expected artifact.

### Task 6: Documentation and decision records

**Files:**
- Update English/Chinese README pairs for session persistence, JSONL, SQLite, attachment-local, Workspace, Apiproxy, and UI Workspace where behavior changed.
- Create: `.agents/notes/implemented/feature/2026-08-26-workspace-purge.md`
- Create: `.agents/notes/implemented/feature/2026-08-26-workspace-purge.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-26-workspace-purge.i18n.yaml`
- Update cross-links in the earlier Workspace-deletion and storage proposal notes without rewriting their historical decisions.

- [ ] **Step 1: Write the implemented Agent Note**

Record ownership expansion, preflight and commit order, recursive Session semantics, filesystem safety, attachment reachability, crash convergence, alternatives, verification, and unavoidable exclusions such as copies exported outside Harness control.

- [ ] **Step 2: Update consumer contracts and bilingual counterparts**

Replace obsolete “metadata only/no deletion” limitations with the shipped behavior, keeping one home per fact and minimal cross-package links.

- [ ] **Step 3: Re-record translation pairs**

Run: `pnpm run verify-translation-pairing --write <each changed pair>`

- [ ] **Step 4: Run documentation gates**

Run: `pnpm run doc-sync`

Run: `pnpm run lint`

Run: `git diff --check`

Expected: pass.

### Task 7: Final validation, commit, and team00 deployment

**Files:**
- No new source files beyond the preceding tasks.

- [ ] **Step 1: Select outgoing checks with `dsh-pre-push-checks`**

Verify `origin/master`, run `pnpm --silent run change-scope --base origin/master`, then run focused coverage for every affected source package plus build/hygiene checks required by changed public service methods and browser artifacts.

- [ ] **Step 2: Review the complete diff**

Confirm no `vendor/` changes, no secrets, no generated artifacts edited by hand, and no unrelated files.

- [ ] **Step 3: Commit and push the feature branch**

Commit every changed file with an evidence-based message, push normally, verify the remote ref, and inspect PR checks if a PR is created.

- [ ] **Step 4: Deploy as a new immutable team00 release**

Use the tracked deployment authority to build a new release from the pushed commit, reapply the existing private-LAN/model-picker/image-command integration, switch `/opt/deepseek-harness/current` only after localhost acceptance, and retain the prior release for rollback.

- [ ] **Step 5: Validate production read/write behavior**

Create an isolated disposable Workspace through the product, add a Session plus representative artifacts, confirm deletion, and verify through the browser and read-only host inspection that the disposable directory, Session log directory, Workspace row, sidecars, and unshared attachments are absent while normal chat, `/image`, runtime status, nginx, and the Harness service remain healthy. Leave inf01 in image-generation profile.
