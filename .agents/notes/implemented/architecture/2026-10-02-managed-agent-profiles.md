# Agent Note: Immutable application-owned assistant profiles

Status: implemented

## Problem

An application backend needs to publish a business assistant identity without copying files through deployment scripts. Reusing a mutable coding preset gives business conversations host tools and permits identity changes after process restart. Existing browser request checks do not authenticate a trusted profile publisher.

## Decision

The preset package stores strictly declarative, immutable profile definitions keyed by application id and version. A caller-supplied digest covers fixed-order JSON; an atomic hard-link publication makes concurrent identical installation idempotent and rejects conflicting content. Profiles accept literal prompt text and the session-MCP composition only. They cannot introduce executable plugin rows or filesystem paths.

The native gateway exposes installation behind a separate environment-supplied bearer secret and rejects browser-origin requests. Session creation selects a generic policy that disables presets, workspace attachment, instruction replacement and forks. Composition reuses session instructions and the user-scoped MCP attachment. The durable profile event records the accepted digest and exact discovered tool names; resume revalidates both instead of selecting a newer published version. The final tool allowlist covers schemas and dispatch, including later local registrations.

The [API reference](../../../../packages/host/apiproxy/agent-profiles.md) owns authentication, digest encoding, requests, storage and error details. Business prompts and tool activation belong to the calling application; tenant access and approval belong to its API.

## Alternatives considered

**Uploading Cordis YAML** grants executable plugin composition to the publisher and makes validation depend on every plugin's configuration. The current consumer needs instructions and existing MCP tools, so the accepted definition contains only those choices.

**Copying and editing named presets** cannot guarantee immutable reconnect behavior and retains deployment ownership of application content. Separate immutable definitions support publication during session setup.

**Using only the browser trust fence** does not authenticate a server. A separate installation secret and rejection of browser metadata keep publication out of the ordinary browser API workflow.

## Consequences

Applications can publish new profile versions without a Harness restart. Existing conversations retain their version and reject changed tool names; tool schemas, business behavior and authorization remain owned by MCP. Old definitions must remain available while their sessions are retained. Administrators with host execution remain trusted.

Focused tests cover immutable publication, concurrent retries, digest and path validation, HTTP authentication and final tool filtering. A keyless Web Loader snapshot covers an MCP invoice lookup, persisted instructions, restart, renewed credentials, tool-set drift and isolation from ordinary coding sessions. Scripted model output verifies transport and composition, not real-model adherence to business instructions.
