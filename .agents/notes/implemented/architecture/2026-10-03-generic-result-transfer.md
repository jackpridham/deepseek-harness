# Agent Note: Canonical result transfer

Status: implemented

## Problem

Models can alter opaque values when transcribing successful tool results into later arguments. Rendered session content cannot recover the canonical value after restart. Domain-specific wrappers duplicate the API owner's tools and identity logic.

## Decision

Managed profile v3 admits generic selection and exact argument transfer. DSH captures finalized canonical values through an awaited loop commit hook, stores immutable scoped snapshots privately, and executes bound arguments through the ordinary admitted registry. API-specific tools remain with their existing owners. See the [result transfer reference](../../../../packages/host/apiproxy/result-transfer.md).

## Consequences

References survive cold recovery within explicit quotas and absolute expiry. The caller pins verified identity and checks capability and composition receipts. Failed or incomplete calls have no reference. Storage failure cannot turn an already-completed mutation into a retryable business failure. Older pinned profiles retain their tools and behavior. The feature does not prevent a model from choosing the same tool repeatedly.

## Alternatives considered

Application-owned mail wrappers add a second business-tool owner. Printing a selected value leaves the transcription step intact. A scripting runtime adds unnecessary execution authority; JSON Pointer selection and literal copying cover the required operation.

## Validation

Focused storage tests cover exact JSON values, pointer escaping, immutable copies, quotas, expiry and recovery. The assembled fake-MCP scenario covers target validation and approval, exclusion, cross-session denial, revoked authorization, cancellation, private provenance and no mutation replay after a lost response. Existing profile and scheduler regressions retain pinned behavior.
