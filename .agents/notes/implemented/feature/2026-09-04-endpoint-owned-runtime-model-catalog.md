# Agent Note: Endpoint-owned runtime model catalogs

Status: implemented

## Problem

A self-hosted gateway can change its served models independently of the Harness. Repeating membership in `settings.yaml` turns each model addition into a coordinated two-deployment change and lets the lists drift.

The earlier [draft endpoint interrogation decision](../../implemented/architecture/2026-08-04-draft-provider-endpoint-interrogation.md) intentionally kept discovery out of runtime routing. That remains the default, but deployments whose gateway owns model membership need an explicit alternative.

## Decision

An OpenAI-compatible pi-ai profile may set `modelsFromEndpoint: true`. Its authenticated `GET /models` response then owns catalog membership in memory. A row may mark itself `selectable: false` to remain visible as endpoint capacity without becoming a conversation model. It may also advertise a default `context_window`, bounded `context_windows` entries whose `model` ids are endpoint-private runtime routes, and bounded reasoning efforts using the `qwen-chat-template` transport. `listModels()` refreshes every call; resolution and streaming refresh on first use and when an unknown model id is requested. Refresh publishes a new immutable adapter snapshot, so in-flight requests retain the catalog with which they began.

The Harness exposes only logical rows in its model selector. Non-selectable rows are muted and rejected by the Host selection boundary. The context selector shows only the selected model's advertised entries, so another model's capacities never bleed into it. Entries may carry `available: false` and an `unavailable_reason`; those tiers remain selectable but show an orange warning with the endpoint's reason and an explicit failure/crash risk. Selecting one submits `bestTryContext: true`, while selecting an ordinary tier omits the override so it cannot bleed across contexts or models. An ordinary request rejects an unavailable tier before provider I/O, while an explicit best-try request may use its advertised private route. The flag is persisted with the session model selection and request header and never permits a context size the endpoint did not advertise. The [complete-context selection decision](2026-09-05-complete-context-selection.md) supersedes the original session-only default policy: an accepted best-try tier also becomes the new-session default.

The Harness persists context and reasoning selections in the session request header, sends the matching private context route to the endpoint, and maps reasoning to `chat_template_kwargs.enable_thinking` while retaining the logical model in Harness state and model provenance. Exact-model resolution supplies the same effective context to admission, token-pressure, and compaction consumers. An unadvertised value or unsupported reasoning transport fails before provider I/O.

An opted-in profile also probes the authenticated sibling `GET /running` endpoint while refreshing. Ready private context routes project an `active` state onto their logical row, and exact media rows project their own state. The selector mutes only a non-selectable row's text, preserving its active marker, and places each menu within the available viewport edge. Runtime status is advisory: a missing or malformed status response leaves the catalog usable and reports no active rows.

Configured `models` entries become per-id overrides for advertised models. They can retain deployment-specific capacities or compatibility fields but cannot keep a removed model selectable. Advertised names, capacities, and input modalities win when present; route defaults cover omissions. The option requires an explicit `baseURL`, and refresh failure fails the operation rather than serving stale membership.

## Verification

A real plugin composition test starts an authenticated mock endpoint, observes a model through `listModels()`, resolves its metadata, and streams with it without adding that id to configuration. It also proves that ordinary and best-try context selection send the corresponding private routes, advertised reasoning changes the provider payload, and failed runtime-state enrichment does not hide a valid catalog. Discovery and Host/UI tests pin parsing, bounded validation, persistence, non-selectable enforcement, active-state projection, and selection.

## Alternatives considered

**Continue copying every model into settings.** Rejected for opted-in authoritative gateways because it preserves the coordinated deployment and drift that motivated the change. It remains the default elsewhere.

**Background polling with a durable cache.** Rejected because selectors and request entry points already provide natural refresh boundaries. Polling adds scheduling, invalidation, persistence, and stale-cache policy without improving this deployment flow.

**Discard configured entries entirely.** Rejected because gateway listings often omit output limits and deployment-specific compatibility. Matching entries remain useful overrides without owning membership.

**Treat every advertised context as ordinarily available.** Rejected because an endpoint can expose a useful best-effort route whose resource requirements conflict with its normal resident set. Availability metadata keeps that distinction endpoint-owned and visible.

## Consequences

A gateway can publish a newly installed model, status-only media route, safe or best-effort context tier, or verified reasoning choice through `/models`, and the Harness picker and request path adopt it without a Harness settings deployment. Context and reasoning menus remain scoped to the selected logical model. A model without reasoning metadata still has a disabled Effort control explaining that the setting is unsupported. Changing context may reload the endpoint worker and discard that worker's KV cache; changing reasoning is request-local. A best-try request may also evict an endpoint resident when the endpoint's scheduler requires it. The endpoint remains responsible for residency and conflict guarantees. The cost is a catalog request and a best-effort status request whenever the picker lists the route, visible catalog outages on catalog-dependent operations, and membership that can change between requests.
