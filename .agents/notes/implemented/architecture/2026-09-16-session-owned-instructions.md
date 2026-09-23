# Agent Note: Session-owned instruction configuration

Status: implemented

## Problem

Callers need durable role and standing instructions independent of task messages and automatically loaded context. Preset-only overrides cannot control per-session source injection or survive client retries predictably.

## Decision

DSH stores exact version-1 instruction inputs as session events. Session creation and pre-first-turn updates call the same session method. System prompt assembly composes literal named blocks after plugin waterfalls, preserving replacement semantics independently of listener order. Automatic AGENTS, workspace, skill catalogue and runtime context sources own their suppression; removing a system section does not erase user-role instruction history.

Instruction inspection explicitly supplies `purpose: 'inspection'` to assembly; absent purpose retains inference admission. Executor plugins can report disconnected state without inventing prior tool schemas or granting execution. Idle status does not identify inspection: a new real prompt can also arrive while idle.

## Alternatives considered

Preset-specific prompt overrides and repeated user-message injection were rejected: they split ownership and duplicate instructions. The caller owns role and standing instruction text while DSH owns application, durability and diagnostics. Configuration is declarative and independent of task messages. Identical retries retain their revision. Freezing configuration before the first turn prevents false claims that changing a switch removes already-read instructions or compacted summaries. CLI files are resolved locally, and validation YAML can opt into the same text-bearing API without making the server interpret remote filenames.

**Removing executor admission or inferring inspection from idle status.** Both allow normal prompting through a missing execution dependency. An explicit per-assembly purpose keeps inspection separate without another persistence format or API response schema.

## Consequences

Executor guidance is a named inherited base contribution and disappears under replacement; executor tool guards remain independent. `host.describe` advertises support, `session.getInstructions` reports effective composition and sources, and configured turn events record their revision. Later live updates need an explicit next-turn API and turn overrides need a whole-turn lifetime; neither exists in version 1.

## Verification

A keyless Loader composition exercises API transport, literal/order composition, idempotency, source suppression, explicit skill access, ordinary-session isolation, actual compaction, durable resume and model request snapshots. CLI tests resolve local text files. Executor integration tests verify replacement retains remote-only tools and host-tool denial. Real-model deployment acceptance is recorded by the deployment repository.
