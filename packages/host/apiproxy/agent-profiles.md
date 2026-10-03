# Managed assistant profiles

Application backends install reviewed assistant instructions and optional native tools through `agentPreset.installProfile`, then select an exact version and digest through `session.create.agentProfile`. Harness owns validation, storage, composition and session persistence. The application owns business identity, profile publication, tenant-scoped MCP credentials and verification before the first message. These profiles are separate from executable agent presets and process boot profiles.

## Installation and authentication

Configure `DSH_PROFILE_INSTALL_TOKEN` in the Harness server environment and keep the same secret in the calling backend. An unset or empty token disables HTTP installation. Use TLS and the deployment's trusted serving authority. `POST /api/agentPreset.installProfile` requires `Authorization: Bearer <service token>`; requests with `Origin`, `Referer` or any `Sec-Fetch-*` header are refused, including same-origin requests with the correct token. There is no browser installation UI or model installation tool. This token authorizes installation only; the existing session API retains its deployment network trust model.

The service secret belongs outside profile definitions, session logs, browser configuration and model context. Host operators and executable Harness plugins remain trusted. Restrict network access to the Harness API to the intended backend and operators; this endpoint does not provide tenant ownership or general Harness authentication.

Check `host.describe.agentProfileVersions` for `1` before sending profile-related fields. Older Harness versions can ignore unfamiliar session fields.

```json
{
  "type": "client-request",
  "rpcId": "install-assistant-1",
  "method": "agentPreset.installProfile",
  "payload": {
    "profile": {
      "schemaVersion": 1,
      "id": "business-assistant",
      "version": "1",
      "systemPrompt": "You help the signed-in user investigate business records using available tools. Cite evidence and propose changes for approval.",
      "tools": "session-mcp"
    },
    "digest": "sha256:<64 lowercase hex characters>"
  }
}
```

The digest is SHA-256 of compact UTF-8 JSON with keys in exactly `schemaVersion`, `id`, `version`, `systemPrompt`, `tools` order. Preserve prompt bytes, including whitespace; use ordinary JSON string escaping and no trailing newline. For example:

```js
const canonical = JSON.stringify({
  schemaVersion: profile.schemaVersion,
  id: profile.id,
  version: profile.version,
  systemPrompt: profile.systemPrompt,
  tools: profile.tools,
});
const digest = `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
```

`id` matches `[a-z0-9][a-z0-9-]{0,63}`; `version` matches `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`. The system prompt contains 1–65536 UTF-8 bytes. All five fields are required. Unknown fields, arbitrary Cordis composition, unsupported schemas and tool modes are rejected. Version 1 exposes only the tools discovered from the session's MCP attachment.

Success returns `result.value = {profile: {id, version, digest}, created: true}`. Identical retries return the same reference with `created: false`, including concurrent installs. Different content under an occupied id/version returns `agent-profile-conflict`; publish a new version instead. Definitions live at `$DSH_HOME/.agent-profiles/<id>/<version>.json`, outside editable presets. Publication is atomic and never overwrites an occupied version. There is no remote deletion or editing operation. Installation needs no process restart and runs no inference or business tool.

## Session creation and verification

Send the returned reference and the existing [user-scoped MCP attachment](session-mcp.md) through `session.create`:

```json
{
  "type": "client-request",
  "rpcId": "create-assistant-1",
  "method": "session.create",
  "payload": {
    "sessionId": "application-conversation-1",
    "agentProfile": {
      "id": "business-assistant",
      "version": "1",
      "digest": "sha256:<accepted digest>"
    },
    "mcpAttachment": {
      "version": 1,
      "serverName": "business",
      "transport": "streamable-http",
      "url": "https://api.example.test/mcp",
      "headers": {"Authorization": "Bearer <user-scoped MCP token>"},
      "toolCallTimeoutMs": 60000,
      "failOnStartupError": true
    }
  }
}
```

Do not also supply a preset, instructions, cwd, workspace or a different session policy. Harness selects `managed-agent-profile-v1`, preserves its existing model selection behavior and replaces the system prompt with the profile's literal text. Automatic Harness instructions, workspace instructions, skill catalogs and runtime context are disabled. No coding preset is mounted. Shell, filesystem, delegation, host tools and later unapproved tool registrations are excluded from both model schemas and execution.

Creation returns the exact `agentProfile: {id, version, digest, toolNames}`, `instructionsRevision`, MCP attachment state and policy attestation. The profile and tool names are durably recorded before success. Before sending `session.prompt`, the backend must compare the returned profile reference and tool names with its intended configuration, then use `session.getInstructions` to verify accepted instructions and the effective prompt. Tool descriptions in the prompt do not activate unavailable services. Business authorization and approval remain the API's responsibility.

Reconnect with the original session id, profile reference and MCP attachment. A live connection requires the same attachment input. After process teardown, supply fresh user credentials for the same MCP server identity. Harness reloads and rehashes the original profile, checks its persisted instructions and requires the same discovered tool names; it rejects missing definitions, changed digests or tool-set drift. Credentials are not persisted. Publishing version 2 affects sessions explicitly created with version 2; version 1 sessions retain their identity. Instructions, presets and session forks cannot replace a profile conversation's composition.

## Native tools in profile v2

Enable `DSH_ALLOW_NATIVE_TOOLS=1` in the host environment to advertise profile version `2` and allow its installation and execution. This explicitly grants the existing backend installer token permission to install service code. The default is disabled. Native modules are trusted in-process Node code, not sandboxed code from browsers or models. Version 1 remains unchanged.

Use the same `agentPreset.installProfile` endpoint and bearer token with this profile definition:

```json
{
  "schemaVersion": 2,
  "id": "application-tools",
  "version": "1",
  "systemPrompt": "Use the supplied tools.",
  "tools": {
    "native": {"source": "<bundled ESM source>", "toolNames": ["echo"]},
    "mcp": []
  }
}
```

Hash compact UTF-8 JSON in the existing top-level order, with nested keys `tools.native`, `tools.mcp`, then `native.source`, `native.toolNames`. Preserve source bytes and array order. Native source is limited to 262144 UTF-8 bytes and the complete serialized profile to 524288 bytes. Each tool list contains at most 128 unique names. Native names match `[a-zA-Z][a-zA-Z0-9_]{0,127}`, exclude `run_code`, and cannot begin with `mcp__`. MCP entries are fully qualified names beginning with `mcp__`.

The single module exports `createTools(options)`, synchronously or asynchronously returning native `ToolDefinition[]`. Bundle dependencies into the source; Node built-ins such as `node:crypto` and `node:fs/promises` work. Relative and bare package imports are not resolved. Installation stores and hashes bytes without executing the module. Session creation imports it and calls the factory once per agent instance. Keep per-session mutable values inside the factory; module globals can be shared.

```js
export function createTools({ sessionId, stateDirectory, binding, mcpAttachment }) {
  return [{
    name: 'echo', description: 'Echo the supplied text.',
    parameters: {
      type: 'object', properties: { text: { type: 'string' } },
      required: ['text'], additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute({ text }, exec) { return text; },
  }];
}
```

DSH validates arguments against the declared JSON schema before execution. `exec.signal` carries cancellation; network calls must use it. Existing tool output validation and rendering apply. The returned names must exactly match `toolNames`; malformed modules or definitions fail creation before the agent is published.

Create or reconnect with `{sessionId, agentProfile, nativeToolBinding, mcpAttachment?}`. `nativeToolBinding` is a required object of at most 32 string fields (keys 1–64 characters, values at most 512); the backend supplies verified tenant, user and conversation identity. Its hash is pinned in the session receipt and log. The object itself is passed privately to the factory as `binding`, never injected into the prompt. A missing or changed binding fails. Credentials belong in the existing attachment, not the binding or profile.

`stateDirectory` is a private persistent directory isolated by profile id/version/digest, session id and binding hash. It survives restart. The application owns file contents, expiry, quotas and retirement; DSH does not automatically prune these directories. Factory closures and file contents must never be returned to the model accidentally. `mcpAttachment`, when supplied, privately carries the current API endpoint and credentials. The factory can call that API directly using trusted identifiers.

`tools.mcp` selects only the named tools from attachment discovery. An empty list allows a native-only session with no attachment, or an attachment used privately by native code. Unselected MCP tools are excluded from both model schemas and execution. Missing selected tools fail creation. Verify `policy.id = managed-agent-profile-v2`, `policy.attestation.tools = profile-native-mcp`, the exact profile digest, `agentProfile.toolNames`, `agentProfile.nativeBindingDigest` and the effective system prompt before prompting.

Live reconnect keeps identical attachment credentials; cold recovery accepts fresh credentials for the same MCP server and requires the original profile and binding. Recovery rebuilds tool definitions without replaying execution. Install a new profile version for new code; existing sessions remain pinned. Rollback selects an already-installed version for new sessions. No package manager, separate registry, uninstall endpoint, inference or Harness restart is needed for tool installation.

## Failure and validation limits

Malformed payloads return `bad-request`; semantic validation and digest mismatch return `agent-profile-invalid`; absent definitions return `agent-profile-not-found`; immutable-version collisions, changed session identity or tool-set drift return `agent-profile-conflict`. Authentication refusal is HTTP 403. MCP failures use the [attachment errors](session-mcp.md). After an interrupted install or an uncertain response, retry the same id/version/content/digest. After an uncertain business operation, inspect business state before retrying it.

The accepted tool names are pinned, while the MCP server continues to own their schemas, implementations and authorization. Offline assembled tests establish instruction delivery, tool isolation, persistence and reconnect behavior against a fixture MCP server. Real invoice access, business approvals, mailbox availability, prompt-injection resistance and model responses require application acceptance with its reviewed profile and actual tools.
