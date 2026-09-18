# Agent Note: Advisory session policy

Status: implemented
Archived: 2026-09-18

## Problem

An external reviewer needs a model session that can inspect supplied evidence without acquiring workspace state, automatic host context, or any executable tool.

## Decision

`session.create({ sessionMode: 'advisory' })` creates a session with no `cwd`, workspace attachment, or agent preset. Its immutable `SessionHeader.sessionMode` survives persistence and reload. The agent scope uses a final no-tool boundary and suppresses runtime prompt context, so model schema assembly is empty and tool dispatch reports an unknown tool even in Code Mode or after a later scoped registration.

`host.describe` returns `advisoryPolicyVersions: [1]`. An advisory create response and `session.getToolPolicy({ sessionId })` attest version 1: `tools` is empty and executor, automatic host context, and workspace access are all false. `session.getToolPolicy` rejects an ordinary session.

## Alternatives considered

**Client-side suppression.** Rejected because another RPC caller could retain the ordinary agent composition or invoke a tool directly.

**An advisory preset.** Rejected because presets can change and would make the no-tool assertion dependent on deployment composition rather than the session's persisted mode.

## Consequences

Advisory sessions cannot use tools, workspace association, automatic host context, or preset-defined behavior; preset selection and forking are refused rather than recomposing the session. A caller needing any of those capabilities creates an ordinary session instead. The policy version permits a consumer to reject an unsupported attestation rather than infer safety from missing fields.

## Verification

The API proxy policy test covers advertised version, advisory create and lookup responses, rejected workspace/cwd/preset input, empty schemas, direct tool-dispatch denial in native, code, and both modes, later scoped registration, runtime-context suppression, mode immutability, selection/fork refusal, and restored-header persistence. Fetch carrier and client fixture tests keep the new RPC row and describe field represented in every in-process implementation. A keyless Loader snapshot boots the shipped Web composition and records the effective policy, rendered prompt, empty context, and empty tool schemas.
