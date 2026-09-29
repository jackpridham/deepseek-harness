# Agent Note: Parent-authorized native child titles

Status: implemented

## Problem

Generic session mutation correctly rejects native children, but diagnostic consumers need persisted presentation titles for both running and idle children. The native role label is not a session title. Idle continuations may have no resident Agent.

## Decision

The [subagent owner](../../../../packages/subagent/subagent/README.md#parent-authorized-child-titles) serializes a synchronous title-service callback with continuation delivery and flushes before acknowledging. Cold children use the existing persistence preparation and temporary session attachment, preserving one history owner without creating a model loop. Diagnostic metadata mutation checks the exact admitted parent run and accepted child assignment. The external integration authenticates callers on its paired executor carrier; this trusted service method does not authenticate network callers itself.

## Alternatives considered

Weakening generic session ownership would expose unrelated mutation paths. Reactivating idle children for metadata would change execution state unnecessarily. Creating another history writer would race native continuation. Creation-time role labels do not supply the explicit-title pinning semantics.

## Consequences

Titles retain normalization and user pinning, and title writes do not change assignments, tools, budgets, model selection or completion. Availability failures remain explicit. Focused owner tests and a keyless Loader snapshot exercise native presentation access; the separately maintained integration owns authenticated transport and persistence-reopen checks. Real runtime acceptance requires separate deployment authorization.
