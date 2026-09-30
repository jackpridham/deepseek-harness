# Agent Note: Diagnostic tree checkpoints and anchored supervision

Status: implemented

## Problem

Long diagnostic investigations expose tool/report errors after substantial accumulated context. Restarting a short fixture cannot reproduce the same history, compaction, worker state or accepted evidence. Relative waits also let time spent inspecting workers drift the next review, and unnamed native failures can be mistaken for rejected reports.

## Decision

[Diagnostic runs](../../../../packages/subagent/subagent/README.md#anchored-reviews-and-tree-checkpoints) negotiate periodic reviews separately from frozen supervision admissions. The server anchors deadlines to first worker launch and commits each wait reply under a caller operation identity. Reports take precedence without advancing the schedule. Exact retries preserve the same response and cadence.

Inspection correlates native calls/results by turn, step and call identity, names source tools and separates closeout attempts. Executor-owned records establish backend validation or caller acceptance attribution; missing history yields unknown attribution. Native report schemas belong in tool definitions, while new worker task messages reference the already assembled expertise and schema rather than duplicating their content.

A [driver checkpoint hold](../../../../packages/core/agent-loop/README.md#explicit-checkpoint-continuation) occurs before inbox consumption, after the current inference/tool step. The diagnostic coordinator holds the root, then all workers, and copies complete histories under the executor/root journal transactions. Pending or uncertain operations prevent executable capture. The executor provider persists and hashes the artifact, then seals a caller commitment to the same boundary, accepted state and sources.

A fork receives new run/session/binding identities. Historical model context and surface/compaction records remain complete. Explicitly remapped diagnostic membership and cursor-bearing records coexist with inert origin metadata; accepted reads and reports remain inherited evidence with original provenance. New guidance and identity mapping are logged continuation inputs. Restoration preserves model settings, deadlines, frozen capabilities, consumed budgets and terminal workers.

## Alternatives considered

**Completed-turn session forks.** Their open-turn rejection and single-session scope do not capture the diagnostic assignment tree, caller journal or a worker between report attempts. Synthetic turn completion would change the context being reproduced.

**Summary reconstruction.** It loses tool results, compaction boundaries and accumulated model context, so it cannot substantiate a faithful continuation experiment.

**Replay unsettled source calls.** Their effects or evidence status may be unknown. Capture refuses execution until existing reconciliation establishes their state.

**Automatic cold fork recovery.** Generic session recovery repairs interrupted turns and cannot establish caller acceptance after a process loss. Version 1 retains partial histories, refuses accidental cold continuation, and permits a new isolated fork operation from the immutable checkpoint.

## Consequences

The provider owns artifact/version/integrity checks and the caller checkpoint handshake. Core restore methods accept trusted provider snapshots; no arbitrary export import is exposed. Caller source journals, snapshot availability, report validation and experiment publication routing remain caller-owned. Hash equality proves matching commitments, not that an external journal URL contains the claimed bytes. Changed tool presentation requires explicit acceptance; source authority and report validators stay frozen.

Native tests cover step holds, cancellation, full and compacted rendered context, multiple workers, frozen limits, exact review retries and operation races. Executor tests cover argument feedback, role schema rendering, immutable capture/sealing, identity isolation, interrupted preparation and explicit no-replay behavior. The Loader snapshot pins optional inspection arguments and anchored waits. Live inference continuation and completed OWASP acceptance require separate caller/operator evidence.
