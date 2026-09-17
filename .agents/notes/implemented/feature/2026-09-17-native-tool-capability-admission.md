# Agent Note: Native tool capability admission

Status: implemented

> Superseded by [Advisory native tool capability](2026-09-17-advisory-native-tool-capability.md). This note records the former admission decision; the endpoint propagation and picker presentation remain, but the pre-inference refusal does not.

## Problem

An endpoint can advertise models that accept ordinary text generation but reject native tool schemas. Sending those schemas starts provider work that cannot produce a valid tool turn, and presenting an omitted capability field as support gives legacy endpoints an unjustified verified status.

## Decision

Endpoint discovery accepts an optional boolean `capabilities.tools` field and projects it as `supportsTools` through exact model resolution and the Host model directory. `false` refuses a non-empty `GenerateOptions.tools` list before worker admission, inference lifecycle publication, or `Models.streamSimple()`. Omitted metadata remains unverified and preserves legacy dispatch. The model picker keeps every row selectable and describes explicit unavailability or unverified support without creating a preference control.

## Alternatives considered

**Hide models that decline tools.** Rejected because a model can still serve text-only turns, and tool availability belongs to the assembled request rather than model selection.

**Treat omitted metadata as false.** Rejected because installed and legacy endpoints commonly omit endpoint extensions; that would silently remove existing working tool routes without evidence.

**Reject in the agent loop.** Rejected because title, compaction, subagent, and direct provider callers share the adapter path, while a loop-local check leaves alternate dispatch paths unprotected.

## Consequences

The endpoint declaration is the only source of a verified tool capability. Tool requests to an explicit negative model fail with `UNSUPPORTED_TOOLS`, naming the provider and model; tool execution and provider success cannot be fabricated from that failure. Endpoint refreshes publish newly observed metadata to future model resolution and picker loads, while a stream keeps its captured profile snapshot.
