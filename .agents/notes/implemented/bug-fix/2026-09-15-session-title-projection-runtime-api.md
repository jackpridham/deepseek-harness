# Agent Note: Session titles use the runtime projection API

Status: implemented

## Problem

A release assembled from the published registry and a fork title overlay silently hid titles: the overlay supplied `schema` and `view`, while the registry required `stateSchema` and `wire`. Manual renames temporarily displayed their RPC response, but subsequent snapshots omitted the title. Source-only tests paired the older registry and registrations and could not detect the mismatch.

## Decision

The [projection registry](../../../../packages/session/session-projection/README.md) and its contributors use the published state/client-view API. Every client-visible registration supplies `stateSchema` and `wire`; internal-only state stays off client snapshots. The change preserves projection state versions and existing title events. The runtime overlay uses the published registry rather than replacing it with an older fork build.

## Alternatives considered

Adding both registration layouts would preserve two APIs and allow source tests to conceal release drift. Replacing the published registry with the older fork registry would break newer base contributors. Rewriting title events would modify valid durable data without repairing publication.

## Consequences

All source contributors compile against the release API. Focused tests cover automatic and manual title projection after JSONL/SQLite reopen, rename followed by API list/history reads, and a keyless Loader-composed title snapshot. Release verification must also exercise the prepared overlays with the pinned base registry; source checks and matching artifact hashes alone cannot prove that assembly works.
