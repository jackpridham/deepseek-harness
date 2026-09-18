# Agent Note: Deployment-owned session policies

Status: implemented

## Problem

An evidence-only reviewer needs durable no-tool and no-host-context guarantees. Encoding its persona and attestation in the general API proxy makes Harness own deployment behavior, while applying restrictions only in that proxy leaves direct agent creation and resume unprotected.

## Decision

Harness persists a versioned `SessionPolicyId` and admits agents only after the registered provider synchronously installs its policy. `AgentRegistry.enter()` enforces provider availability and workspace, preset, and fork restrictions before creation announcements. JSONL and SQLite retain the identifier; forks inherit it. SQLite uses schema 18 and rejects older databases. Retired `sessionMode` headers and API inputs reject rather than falling back to ordinary composition.

The API exposes available policy ids, accepts an immutable policy choice at creation, and returns assertions from the exact provider installed on the live agent. A policy query resumes a cold session before answering. Provider removal blocks future admission; effects installed through the agent scope and captured assertions remain with already-live agents.

Vortex owns the advisory prompt, version-one assertions, and composition in `Integrations/deepseek-harness/validation/advisory/`. Harness owns `denyAllTools()` and generic admission, not a reviewer persona. This supersedes the placement and enforcement mechanism in the [advisory policy decision](../../archived/feature/2026-09-18-advisory-session-policy.md).

## Execution permissions

The deployment supplies `sandbox-policy.protectedPaths`. Harness canonicalizes those absolute paths and attaches them only to `read-only` and `workspace-write` policies. The local bwrap runner replaces protected directories with read-only empty mounts, masks files and sockets, and uses a private PID namespace so host `/proc/<pid>/root` aliases cannot restore access. In-process filesystem resolution rejects protected canonical targets. When the service account cannot traverse a configured root, both implementations protect its nearest inspectable ancestor; filesystem matching treats this as a deny-only expansion, so unrelated paths remain usable and writable grants do not broaden. Shell, terminals, search, LSP, ACP, Codex, and Claude Code launches carry the same resolved policy through the subprocess seam. A DSH SDK child cannot receive the host mask, so it rejects lower-mode delegation. Unsupported confined runners reject rather than falling back to host execution.

`danger-full-access` omits the mask: it has every path the service account may ordinarily access, but grants neither sudo/root nor any extra socket privilege. This execution setting is separate from an advisory session policy. Trusted in-process plugins and remote executors are not hostile-plugin isolation mechanisms.

## Alternatives considered

**Client-side suppression.** Another caller could retain executable tools; enforcement belongs on agent admission and tool dispatch.

**A mutable preset alone.** Preset selection and composition updates cannot provide an immutable required policy identity. A missing policy provider must reject resume.

**A built-in advisory mode.** This couples the storage and gateway APIs to one deployment's reviewer behavior. The generic registry retains the durability guarantee while keeping its implementation with its consumer.

**Service-wide path masking.** A single account-level deny list prevents approved full-access sessions from using ordinary service-account capability and makes deployment changes unnecessarily broad.

## Consequences

Policy identifiers version provider guarantees; providers must change ids when those guarantees change. Trusted in-process plugins remain trusted: this mechanism is not a sandbox for hostile plugin code. Installation is synchronous and contributions must belong to the agent scope. No compatibility migration or deployment is implied.

Protected paths remain deployment data, not a Harness hardcoded host list. Lower-mode local execution depends on an enforcing bwrap runner; absent runner support is a diagnostic failure. The mask prevents contents and control-socket use, while a directory name may remain visible through unrelated metadata paths.

## Verification

Factory tests cover missing providers, failed installation, direct creation, provider replacement, metadata denial, and actual disk resume. Shared persistence tests exercise policy round trips on both backends. The Loader snapshot pins generic composition output; Vortex's integration test owns the reviewer prompt and advisory attestation, dispatch denial, and disk-resume behavior.

Sandbox-policy, filesystem, subprocess, LSP, and subagent tests cover policy propagation and fail-closed runners. A real local bwrap fixture verifies read-only and workspace-write modes against dummy credentials, a Unix socket, inaccessible-parent paths, and a host-proc alias without model inference or network traffic. The assembled headless snapshot also carries an inaccessible protected root: an unrelated workspace write succeeds without approval while the protected write remains denied.
