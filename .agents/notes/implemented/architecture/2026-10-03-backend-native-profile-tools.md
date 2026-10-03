# Agent Note: Backend-installed native profile tools

Status: implemented

## Problem

Agents needs to install executable business tools without requiring a Harness deployment for each release. The v1 profile accepts only a prompt and MCP attachment.

## Decision

Application backends install one self-contained native ESM tool module inside an immutable v2 assistant profile. The existing authenticated profile endpoint, atomic storage and content digest own publication; the session tool registry owns execution and disposal. A separate package registry and dependency installer are unnecessary for the current Agents consumer.

## Consequences

The host explicitly enables executable installation with `DSH_ALLOW_NATIVE_TOOLS=1`. The module factory receives private session storage, a pinned backend identity binding and current MCP credentials. The factory returns native definitions, while the profile declares the exact native roster and admitted MCP subset. Version 1 remains MCP-only. Application-specific state remains application-owned. Generic exact result transfer is separately provided by [profile v3](2026-10-03-generic-result-transfer.md); it does not require native business-tool wrappers.

See the [profile reference](../../../../packages/host/apiproxy/agent-profiles.md#native-tools-in-profile-v2) for wire fields, source limits, authorization and recovery.

## Alternatives considered

A separate package registry and installer would duplicate immutable profile storage. An MCP wrapper would add a service and leave application execution remote. Embedding one bundled module keeps the existing delivery pathway and limits this version to the current consumer.

## Validation

The profile store tests cover opt-in, canonical hashing, immutable conflicts and concurrent publication. The assembled [session fixture](../../../../examples/acp-agent/tests/session-mcp.snapshot.ts) exercises the HTTP install path, native execution, private state isolation, cold recovery, explicit MCP admission and rejected arguments without inference.
