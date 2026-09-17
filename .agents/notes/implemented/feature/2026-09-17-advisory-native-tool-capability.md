# Agent Note: Advisory native tool capability

Status: implemented

## Problem

Treating a catalog observation as permission to run a Standard-mode request made useful models unavailable whenever their exact serving setup had not recently passed tool qualification. That conflated native-call reliability with the ability to review, summarise, reason, or answer normally while the assembled request still offered tools.

## Decision

`capabilities.tools` remains an optional endpoint boolean projected as `supportsTools` into model resolution and the picker. `false` displays **No native tools**, omission displays **Tool support unknown**, and both remain selectable. The Pi-AI adapter always forwards the request's offered tools regardless of this advisory value. Native tool calls continue through the ordinary dispatch pipeline; fenced JSON, XML, and prose remain assistant content and acquire no executable meaning.

This reverses the admission decision in [Native tool capability admission](2026-09-17-native-tool-capability-admission.md) while retaining its metadata transport and display surface.

## Alternatives considered

**Strip tool schemas from requests to explicit-negative models.** Rejected because Standard mode owns its assembled tool surface, and silently changing that surface makes request evidence misleading.

**Infer missing metadata as false.** Rejected because absence means only that support has not been declared. Classification can be added incrementally from observed behavior.

**Parse pseudo-calls from assistant text.** Rejected because untrusted prose is not a native provider call and must never become an execution path.

## Consequences

Tool capability is presentation metadata rather than admission control. A model may complete useful Standard-mode work whether its value is true, false, or absent. Provider and session evidence remains the authority for whether a particular response emitted a genuine native call, and only native calls are dispatchable.
