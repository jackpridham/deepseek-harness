# Agent Note: Remote Models catalog in Settings

Status: implemented

## Problem

The Models Settings page required the loopback-only settings mirror before it read any data, so a trusted remote browser could not inspect the same catalog that the composer displays.

## Decision

The Models page reads `llm.models` independently from provider settings. It renders the Host's provider groups, model names and ids, advertised context tiers, active state when reported, and provider-local catalog failures. The settings mirror still controls provider and credential rows, so a remote browser receives a catalog without `settings.*` or credential access. When an ordinary active chat exists, Settings renders the shared composer ModelSelect over that chat's existing ModelDirectory; no session is created, and the existing picker retains its established selection/default behavior.

## Alternatives considered

**Make the settings mirror available remotely.** This would widen the configuration and credential surface only to show model rows.

**Create a synthetic session for the existing selector.** A catalog page has no session ownership, and manufacturing one would mix inventory with chat selection and defaults.

## Consequences

The catalog uses the existing host-scoped RPC and remains independent of session state. It deliberately shows an unreported runtime state as unavailable rather than unloaded; Lifecycle controls are plugin-owned catalog-row actions; Settings supplies their typed row facts without taking provider lifecycle ownership.

ModelControls snapshots and operations preserve backend `progress` for the current load stage. The host forwards the same optional data through durable `model/lifecycle` events so Settings and chat can present measured counters consistently. Readiness waits use local display IDs without issuing backend operation polls, and settlement clears their loading state. Percentages describe weight or checkpoint-shard stages; initialization has no estimated percentage or completion time.
