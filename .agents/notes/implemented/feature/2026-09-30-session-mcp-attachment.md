# Agent Note: Session-owned HTTP MCP attachment

Status: implemented

## Problem

An application can prepare an authenticated MCP endpoint but cannot supply it to a central Harness session. Static host configuration shares a server identity across callers and cannot represent independent application credentials.

## Decision

The [Host API](../../../../packages/host/apiproxy/session-mcp.md) accepts one versioned HTTP attachment in `session.create`, mounts the stock MCP client in the agent scope before publication, and returns discovered public tool names. MCP server-name reservations use the registration scope. The caller retains credentials and supplies them again on cold resume; a required `mcp/attached` event retains only the server identity. Live replacement conflicts. Session teardown owns connection disposal.

## Alternatives considered

**Static per-application presets:** endpoint credentials would become deployment settings and sessions could not independently authenticate to the same server.

**A separate attachment CRUD API:** the current caller needs one server before its first prompt. Creation provides the lifecycle and rollback boundary without another mutable resource.

## Consequences

Agents can forward API-owned endpoint settings while DSH retains inference and tool execution. Initial discovery failure prevents session publication. Automatic reconnect, credential persistence, resources/prompts and live rotation are deferred. Repeated session creation never replays a task or business tool call; uncertain mutations remain the caller's responsibility to reconcile.
