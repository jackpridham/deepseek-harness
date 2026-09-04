# Agent Note: Endpoint-owned runtime model catalogs

Status: implemented

## Problem

A self-hosted gateway can change its served models independently of the Harness. Repeating membership in `settings.yaml` turns each model addition into a coordinated two-deployment change and lets the lists drift.

The earlier [draft endpoint interrogation decision](../../implemented/architecture/2026-08-04-draft-provider-endpoint-interrogation.md) intentionally kept discovery out of runtime routing. That remains the default, but deployments whose gateway owns model membership need an explicit alternative.

## Decision

An OpenAI-compatible pi-ai profile may set `modelsFromEndpoint: true`. Its authenticated `GET /models` response then owns selectable membership in memory. A row may also advertise a default `context_window`, bounded `context_windows` entries whose `model` ids are endpoint-private runtime routes, and bounded reasoning efforts using the `qwen-chat-template` transport. `listModels()` refreshes every call; resolution and streaming refresh on first use and when an unknown model id is requested. Refresh publishes a new immutable adapter snapshot, so in-flight requests retain the catalog with which they began.

The Harness exposes only the logical row in its model selector and offers only its advertised context and reasoning values. It persists both selections in the session request header, sends the matching private context route to the endpoint, and maps reasoning to `chat_template_kwargs.enable_thinking` while retaining the logical model in Harness state and model provenance. Exact-model resolution supplies the same effective context to admission, token-pressure, and compaction consumers. An unadvertised value or unsupported reasoning transport fails before provider I/O.

Configured `models` entries become per-id overrides for advertised models. They can retain deployment-specific capacities or compatibility fields but cannot keep a removed model selectable. Advertised names, capacities, and input modalities win when present; route defaults cover omissions. The option requires an explicit `baseURL`, and refresh failure fails the operation rather than serving stale membership.

## Verification

A real plugin composition test starts an authenticated mock endpoint, observes a model through `listModels()`, resolves its metadata, and streams with it without adding that id to configuration. It also proves that selecting an advertised context sends the corresponding private route and that advertised reasoning changes the provider payload. Discovery and Host/UI tests pin parsing, bounded validation, persistence, and selection.

## Alternatives considered

**Continue copying every model into settings.** Rejected for opted-in authoritative gateways because it preserves the coordinated deployment and drift that motivated the change. It remains the default elsewhere.

**Background polling with a durable cache.** Rejected because selectors and request entry points already provide natural refresh boundaries. Polling adds scheduling, invalidation, persistence, and stale-cache policy without improving this deployment flow.

**Discard configured entries entirely.** Rejected because gateway listings often omit output limits and deployment-specific compatibility. Matching entries remain useful overrides without owning membership.

## Consequences

A gateway can publish a newly installed model, safe context tier, or verified reasoning choice through `/models`, and the Harness picker and request path adopt it without a Harness settings deployment. Changing context may reload the endpoint worker and discard that worker's KV cache; changing reasoning is request-local. The endpoint remains responsible for its residency and swap-group guarantees. The cost is one catalog request whenever the picker lists the route, visible endpoint outages on catalog-dependent operations, and membership that can change between requests.
