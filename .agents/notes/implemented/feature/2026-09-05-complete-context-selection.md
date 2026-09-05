# Agent Note: Complete context selection across sessions and titles

Status: implemented

## Problem

A 256K chat could be followed by a new chat showing its model's ordinary context. Even after selecting 256K again, automatic title generation omitted the context tier and requested the model's default route. An endpoint with mutually exclusive context workers unloaded the selected worker, loaded the default context for the title, and loaded the selected context again for chat.

## Decision

The Host saves every accepted complete model selection, including `bestTryContext`, through the existing default-model settings service. New or blank sessions inherit that selection; sessions with a logged selection retain their own choice. This supersedes the session-only best-try default policy in the [endpoint catalog decision](2026-09-04-endpoint-owned-runtime-model-catalog.md). Only an explicitly accepted advertised tier supplies the flag; ordinary selections clear it.

Title generation captures provider, model, context tier, and best-try acceptance at the triggering request. Deferred work keeps that captured route even if the session changes before dispatch. Automatic first-prompt, later unchanged-header, and explicit refresh paths use the same projection. An explicit title provider/model override retains independent model defaults. The auxiliary request log records the context sent to inference, and accepted title provenance retains it.

## Alternatives considered

**Retain session-only best-try defaults.** Rejected because it silently resets an accepted context on New Session and forces the user to select the same tier repeatedly. The endpoint's unavailable-tier warning and advertised-size validation remain intact.

**Disable title generation or change scheduler eviction.** Rejected because title requests themselves discarded the selected route. Preserving that route fixes all inherited model-backed title providers without changing inference lifecycle policy.

## Consequences

New chats inherit an accepted best-try tier, including its possible memory pressure or load failure. This is a remembered user selection, not a guarantee that the worker remains resident. Title generation still consumes inference capacity but no longer changes context merely because the title is short. Explicitly configured alternate title models may still require an endpoint transition.

## Verification

Settings and Host tests cover accepted best-try persistence, ordinary-tier clearing, and rejection of unadvertised sizes. The real web application has a keyless snapshot of saved, new-chat, and existing-chat selections. Loader composition covers deferred automatic title routing and explicit refresh; service tests cover unchanged-header scheduling, and LLM tests assert dispatched and logged context plus independent override behavior.
