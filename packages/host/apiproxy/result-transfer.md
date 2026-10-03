# Canonical result transfer

DSH owns generic selection and exact argument transfer. API servers retain their business tools, schemas, credentials and authorization. The calling gateway owns authenticated identity, capability admission and profile selection. No executable module, scripting engine, additional MCP server or domain-specific identifier map is required.

## Admission and receipts

Require `host.describe.agentProfileVersions` to include `3` and `resultTransferVersions` to include `1`. Install through the existing backend-authenticated `agentPreset.installProfile` endpoint:

```json
{
  "schemaVersion": 3,
  "id": "business-assistant",
  "version": "result-transfer-1",
  "systemPrompt": "Use result references and JSON Pointers to transfer values into tool arguments.",
  "tools": {
    "mcp": ["mcp__api_vxapp__search", "mcp__api_vxapp__read"],
    "resultTransfer": {
      "version": 1,
      "maxResults": 128,
      "maxBytes": 8388608,
      "ttlSeconds": 86400
    }
  }
}
```

Use actual discovered MCP names. Hash compact UTF-8 JSON in top-level `schemaVersion,id,version,systemPrompt,tools` order, nested `tools.mcp,tools.resultTransfer` order, then `version,maxResults,maxBytes,ttlSeconds`. Preserve strings and array order. The existing immutable profile installation limits and digest checks apply. Version 3 needs no native-code opt-in. Versions 1 and 2 retain their existing digests, tool rosters and policies.

Send `session.create` the installed `agentProfile`, original `sessionId`, usual `mcpAttachment`, and `resultTransferBinding: {tenant,user,conversation}`. Each identity field is a nonempty string of at most 512 characters, supplied by the trusted gateway from its authentication/session state, never from the model. Credentials remain in the MCP attachment. Do not also send `nativeToolBinding`.

Before prompting, verify the exact profile reference; `policy.id = managed-agent-profile-v3`; `policy.attestation.tools = profile-mcp-result-transfer`; `policy.attestation.resultTransfer = 1`; `immutableProfile = true`; and the sorted `agentProfile.toolNames`, which must equal the selected MCP names plus `call_with_result` and `result_select`. Verify the returned `resultTransfer` limits, `resultBindingDigest`, instruction revision and effective prompt. The identity digest is SHA-256 of compact JSON with binding keys sorted lexically (`conversation,tenant,user`), prefixed `sha256:`. Missing capabilities or mismatched receipts must fail admission. Do not silently upgrade an existing pinned conversation.

## Operations

Every eligible completed tool result receives a notice such as `Result reference: r_a1840082f795ccb8ad7262ce; JSON Pointer root: structuredContent.` References contain 96 random bits and are meaningful only in their owning session. They identify captured snapshots, not queries that will be refreshed.

`result_select({result,source})` inspects the captured root. `source` is an RFC 6901 JSON Pointer: `""` selects the root, `/messages/3` selects the fourth array element, `~1` escapes `/`, and `~0` escapes `~`. URI fragments, expressions, leading-zero array indices and `-` append syntax are unsupported. Missing paths fail; explicit null is a value. Pointers are limited to 2048 characters.

A selection returns `{result,source,value,truncated:false}` if the complete JSON response fits 4096 UTF-8 bytes. Otherwise it returns `{result,source,truncated:true,type,bytes}` without a partial value. A pointer whose summary itself exceeds the output budget fails. The reference and pointer remain usable for exact transfer regardless of preview size.

```json
{
  "tool": "mcp__api_vxapp__get_microsoft_message",
  "arguments": {"bodyOffset": 0},
  "bindings": [
    {"target": "/mailboxGUID", "result": "r_a1840082f795ccb8ad7262ce", "source": "/messages/3/mailboxGUID"},
    {"target": "/messageID", "result": "r_a1840082f795ccb8ad7262ce", "source": "/messages/3/messageID"}
  ]
}
```

Pass this object to `call_with_result`. It copies exact JSON values, preserving string contents and JSON types, into a detached target argument object. The model supplies only handles and pointers for bound values. Bindings must number 1–32; destinations must not overlap or replace the root. Object destinations must be absent, with parent containers already present. Array destinations must be existing null placeholders; transfer never appends or resizes arrays. Literal argument members cannot be silently overwritten. Both the transfer request and resolved arguments are limited to 262144 UTF-8 bytes.

Unknown, retired, expired, foreign, unsuccessful or incomplete results have no usable reference. Invalid pointers, conflicts, oversize arguments, excluded targets and invalid target arguments fail before any target invocation. Recursive invocation of either generic operation or `run_code` is rejected. Values remain data; there is no evaluation, repair or fuzzy matching.

## Canonical capture and execution

The awaited `tools/commit-content` hook runs in model order after final output validation, policy and cancellation handling, before the loop logs or exposes model-facing content. It receives canonical `ToolExecutionResult.value`; values are never reconstructed from rendered history. MCP roots are exactly `value.structuredContent` when present. MCP results without that field are not selectable, even if their text looks like JSON. Other structured tool results use the complete validated `value`, including arrays, scalars and explicit null. Canceled, failed or policy-blocked results are not captured. A completed page with a continuation cursor is a valid snapshot of that page; transfer does not complete the query.

DSH persists the canonical snapshot atomically and syncs it before publishing the handle. Capture failure or an oversized result leaves the original successful tool outcome intact and adds an unavailable-reference notice: it must not encourage replay of a completed mutation. No handle is exposed for a failed capture. The selection tool does not recursively capture its own previews.

Bindings resolve before target JSON Schema validation and target concurrency classification. Target validation uses AJV 2020 with format validation, without coercion, default insertion or property removal. Uncompilable schemas fail closed. The same session-scoped registry executes the resolved call, preserving target pre-execution policy/approval, authorization, credentials, cancellation, timeout and output handling. The target's concurrency classifier sees resolved arguments; unavailable classification remains exclusive. The generic transport also passes through normal policy, and cannot grant access to excluded tools.

`tool/result-reference` records the handle, source tool/call and root. `tool/result-transfer` records the actual target identity, parent/target call IDs, binding pointers and start/finish status, without copying bound values or credentials into diagnostics. A started transfer is flushed before target execution. Target errors preserve their machine code when present. An interrupted response may have an uncertain outcome; neither recovery nor this feature automatically retries it. Application-level idempotency and reconciliation remain the business tool owner's responsibility.

## Storage, recovery and retirement

Private storage lives at `$DSH_HOME/.tool-results/<sha256(sessionId)>/results.json` in a 0700 directory with a 0600 file. Its scope digest binds session incarnation, immutable profile and trusted identity. Files include canonical values, immutable provenance, content hashes and absolute expiry; treat them as private session data in backups. Exported rendered transcripts alone cannot restore references.

The profile explicitly chooses `maxResults` (1–128), `maxBytes` (1024–8388608, counting the whole serialized store including metadata), and `ttlSeconds` (1–86400). Oldest entries retire first when count or byte limits are reached. An individually oversized result is not captured and does not evict retained entries. Atomic replacement can temporarily require twice the file quota. There is one writer per session, owned by the existing agent loop.

Reads never renew expiry. Expired references fail immediately; expired bytes are pruned on store reopen or the next capture. Dormant session files have no background time-based eraser. `workspace.deleteSession` cancels and drains the session, then deletes its canonical store through the existing purge path before deleting the session log. Operators requiring physical deletion at a wall-clock deadline must retire those sessions; retention backups remain subject to their own policy.

Live reconnect requires the same profile, identity and attachment. Cold recovery requires the original identity and fresh credentials for the same MCP server, reloads valid references, and performs no source or target calls. Missing storage makes old references unavailable; corrupt or foreign-scope storage fails recovery. Current API authorization still applies on every target execution. Gateway session authentication remains mandatory: identity hashes bind state but are not bearer authentication for the Harness HTTP API.
