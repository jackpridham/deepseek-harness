# Agent Note: Deployment-owned session policies

Status: implemented

## Problem

An evidence-only reviewer needs durable no-tool and no-host-context guarantees. Encoding its persona and attestation in the general API proxy makes Harness own deployment behavior, while applying restrictions only in that proxy leaves direct agent creation and resume unprotected.

## Decision

Harness persists a versioned `SessionPolicyId` and admits agents only after the registered provider synchronously installs its policy. `AgentRegistry.enter()` enforces provider availability and workspace, preset, and fork restrictions before creation announcements. JSONL and SQLite retain the identifier; forks inherit it. SQLite uses schema 18 and rejects older databases. Retired `sessionMode` headers and API inputs reject rather than falling back to ordinary composition.

The API exposes available policy ids, accepts an immutable policy choice at creation, and returns assertions from the exact provider installed on the live agent. A policy query resumes a cold session before answering. Provider removal blocks future admission; effects installed through the agent scope and captured assertions remain with already-live agents.

Vortex owns the advisory prompt, version-one assertions, and composition in `Integrations/deepseek-harness/validation/advisory/`. Harness owns `denyAllTools()` and generic admission, not a reviewer persona. This supersedes the placement and enforcement mechanism in the [advisory policy decision](../../archived/feature/2026-09-18-advisory-session-policy.md).

## Alternatives considered

**Client-side suppression.** Another caller could retain executable tools; enforcement belongs on agent admission and tool dispatch.

**A mutable preset alone.** Preset selection and composition updates cannot provide an immutable required policy identity. A missing policy provider must reject resume.

**A built-in advisory mode.** This couples the storage and gateway APIs to one deployment's reviewer behavior. The generic registry retains the durability guarantee while keeping its implementation with its consumer.

## Consequences

Policy identifiers version provider guarantees; providers must change ids when those guarantees change. Trusted in-process plugins remain trusted: this mechanism is not a sandbox for hostile plugin code. Installation is synchronous and contributions must belong to the agent scope. No compatibility migration or deployment is implied.

## Verification

Factory tests cover missing providers, failed installation, direct creation, provider replacement, metadata denial, and actual disk resume. Shared persistence tests exercise policy round trips on both backends. The Loader snapshot pins generic composition output; Vortex's integration test owns the reviewer prompt and advisory attestation, dispatch denial, and disk-resume behavior.
