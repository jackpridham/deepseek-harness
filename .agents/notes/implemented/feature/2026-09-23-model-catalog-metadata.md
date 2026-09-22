# Agent Note: Model descriptions and release dates in Settings

Status: implemented

## Problem

The Models inventory does not explain model strengths or age, and endpoint descriptions disappear during discovery before reaching the browser.

## Decision

The existing discovery, adapter catalog, and API projection carry optional descriptions, ISO release dates, and source URLs. Settings displays the description and date, links the model name to HTTP(S) sources, and sorts each provider's inventory by descending release date with unknown dates last. Catalog authors own the date provenance; inference behavior and chat selection remain independent.

## Alternatives considered

**Plugin-only metadata fetch:** fetching INF01 again in every row would duplicate discovery and prevent the inventory itself from sorting by date. The shared catalog already owns these rows.

**Repository creation timestamps as release dates:** a model repository can exist before weights become available. Catalog research must establish release evidence or leave the date unknown.

## Consequences

The metadata uses the existing API and adds no dependency or separate cache. Existing providers need not supply it. The browser rejects non-HTTP(S) hyperlinks and renders descriptions as text. Dates remain calendar strings, avoiding timezone shifts.

## Testing

The discovery suite preserves endpoint metadata. The Models Settings browser scenario boots the real web composition with a local listing endpoint and snapshots a newer inventory model above an older chat model, followed by an unknown-date model. It checks description rendering, date text, model-card links, and rejection of a script URL.
