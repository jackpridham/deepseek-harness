# Agent Note: Omit inactive tools during provider finalization

Status: implemented

## Problem

Caller closeout disables tools while retaining their history and requiring a final assistant response. The pi-ai OpenAI-completions serializer adds `tools: []` for any tool history, although Flash's endpoint rejects empty arrays. An Anthropic proxy workaround therefore prevents completion on an unrelated provider.

## Decision

The [maintained dependency patch](../../../../patches/@earendil-works__pi-ai@0.82.1.patch) limits that fallback to Claude model IDs (`claude-*` or slash-qualified `*/claude-*`). With no active tools, other models omit `tools`; all models omit `tool_choice`. Active tool definitions and prior calls/results remain intact.

## Alternatives considered

Removing the fallback entirely would discard its documented Anthropic proxy compatibility purpose. Adding dummy tools or restoring completed tools would violate the session's execution policy. Removing historical calls would erase report authority. A new deployment option is unnecessary for the known named routes; arbitrarily aliased Claude proxies require explicit investigation before widening detection.

## Consequences

Finalization reaches endpoints that reject empty arrays without changing caller validation or tool execution. The wire regression captures the SDK's actual HTTP body for active tools, tool history, no history, and Claude compatibility. Claude proxy acceptance is retained by source behavior and regression, not established by a live Claude call.
