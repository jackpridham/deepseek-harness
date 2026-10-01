# Session MCP attachment v1

`host.describe` advertises `mcpAttachmentVersions: [1]`. A caller must check this before submitting credentials; older servers may ignore unknown request fields.

Send `POST /api/session.create` using the normal RPC envelope:

```json
{
  "type": "client-request",
  "rpcId": "create-1",
  "method": "session.create",
  "payload": {
    "sessionId": "api-request-example",
    "agentPreset": "standard",
    "mcpAttachment": {
      "version": 1,
      "serverName": "api_vxapp",
      "transport": "streamable-http",
      "url": "https://api.example.test/v2/Ai/Mcp",
      "headers": {
        "Authorization": "Bearer <API-issued token>",
        "Vx-Api-Guid": "<API context GUID>"
      },
      "toolCallTimeoutMs": 60000,
      "failOnStartupError": true
    }
  }
}
```

The successful `result.value` contains the existing `sessionId` and optional preset fields, plus:

```json
{
  "mcpAttachment": {
    "version": 1,
    "serverName": "api_vxapp",
    "toolNames": ["mcp__api_vxapp__get_invoice"]
  }
}
```

The tool list above is illustrative. The server returns all discovered public names. API-vxapp callers should verify their expected ten tools before submitting a task through the existing `session.prompt` operation. DSH has no API-specific catalogue or tool implementation. Initialization and discovery run during creation; they do not run inference or call business tools. JSON HTTP responses, notification acknowledgements and a server returning 405 for GET are supported by the stock MCP transport.

Version 1 accepts one HTTP(S) endpoint, a server name matching `[A-Za-z0-9_-]{1,32}`, a header map, a tool timeout of 1–300000 ms, and mandatory startup failure propagation. URL user information and fragments are rejected. The attachment belongs to the session agent's tool scope, so concurrent sessions can use identical server names with different headers. Session policies that disable presets also reject caller attachments, except the generic [managed assistant policy](agent-profiles.md), which requires one.

An identical `session.create` for a live session returns its attachment and current tool names. Changed attachment input returns `mcp-attachment-conflict`; attaching to an already live ordinary session also conflicts. Create a new session to change its endpoint or credentials. Inspection through repeated creation performs no tool calls, but may resume a cold session.

The session log records the server name and URL. Headers remain in the live attachment; they are not durable configuration. After teardown or restart, repeat `session.create` with the same session ID, preset, workspace/cwd and attachment. The server identity must match; fresh credentials may be supplied on cold resume. An attached session cannot resume without its attachment. Forking attached history without attachment input is unsupported. Existing interruption and deletion operations retain their normal meanings; deletion disposes the connection and its tools.

Errors are `mcp-attachment-failed` for initialization/discovery failure, `mcp-attachment-required` for missing cold-resume input, `mcp-attachment-conflict` for incompatible reuse, and `mcp-attachment-policy` for a policy refusing the attachment. Generic cold-resolution methods may wrap the required-attachment error in their existing error envelope; explicit `session.create` returns the named code. Invalid request fields use the existing `bad-request` response.

Automatic MCP reconnection is disabled for these attachments. Failed or interrupted execution never automatically resubmits a tool call. A tool timeout or cancelled run does not establish whether a remote invoice mutation committed; the caller must inspect business state before retrying. Resources, prompts, live attachment replacement, automatic reconnect and durable credential storage are outside version 1.
