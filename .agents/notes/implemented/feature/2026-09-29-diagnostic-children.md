# Agent Note: Caller-prepared diagnostic children

Status: implemented

## Problem

Source-review callers need independently assigned native child sessions whose instructions, model, tools and budgets cannot widen after admission. A lost transport acknowledgement cannot safely authorize a second child or replay uncertain work.

## Decision

The existing immutable session-policy mechanism selects `vortex-diagnostic-children-v1` at root creation. This uses the existing `session.create.sessionPolicy` field; callers must select it before executor pairing. Ordinary roots cannot be upgraded in place. The executor remains inert until core admission commits its complete input in the central session log.

Prepared assignments, child reservations, request charges and executor receipts share the existing durable log. Native continuable children retain their existing identity, discovery and teardown owner. The private reservation event retains delivery acknowledgement metadata; public assignment, child and run events describe observable lifecycle state. Source tools are scoped registrations, and resident deny rules survive withdrawal of the executor provider. Assignment tools are enforced both at prompt assembly and execution, including child-local contributions registered after inherited-tool restrictions. Persisted no-workspace diagnostic sessions remain inspectable while their attesting policy is registered; ordinary internal no-workspace sessions remain excluded.

The policy freezes provider, model, context window, authored role settings and the exact replacement instruction snapshot. Every request reserves its output ceiling before dispatch; this deliberately favors bounded accounting over usage-based refunds. Unknown reservations require reconciliation instead of replay. The existing trusted-LAN history boundary remains: original tool arguments are retained, with no new per-user ACL or retention subsystem.

## Alternatives considered

A second child scheduler and receipt database would duplicate native session ownership and create another recovery authority. Allowing callers to upgrade ordinary sessions would make restart enforcement depend on an optional late-installed guard. Full JSON Schema reference resolution would add an unnecessary fetch and trust policy; closeout schemas use an explicit bounded inline subset.

## Consequences

Callers must create policy-bound roots and install the matching executor bridge before capability discovery succeeds. The bridge owns source reads and bearer pairing; core owns sessions, assignments and model work. Missing providers and uncertain operations fail closed. Source filesystem and egress isolation remain the caller's responsibility, and sensitive use requires genuine deployment acceptance.

Verification includes the published assignment fixtures, a real native-child unit test, a keyless Loader snapshot, and the Vortex plugin's built-Harness read-provenance test. Live inference, caller sandbox acceptance and host deployment are separate checks. Three continuation tests concerning automatic output-limit continuation also fail at the unchanged baseline revision and are unrelated to diagnostic admission.
