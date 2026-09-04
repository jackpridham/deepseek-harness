# Agent Note: Session model selection in the Web composer

Status: implemented

English | [中文](2026-07-24-web-session-model-selector.zh.md)

## Problem

The Web conversation needs a visible, mutable session model selection sourced from the Host. Copying TUI presentation or hardcoding DeepSeek models in the browser would split model discovery and step-boundary semantics across front ends. A switch made while a response is running also needs one atomic boundary: prompt variables and request routing cannot observe different selections.

## Decision

The Web Host installs `ModelSelection` for every created or resumed Agent. The provider/model/reasoning selection comes from the latest `request/header` when the session has used a model, otherwise from `ctx.agentDefaultModel`. `session.selectModel` assigns the session-local selection, and prompt assembly captures it with request routing; a switch during a running step therefore applies to the next assembled step. The next consumed selection persists through the full `request/header` snapshot, while a choice that has not reached a request remains process-local.

The session RPC domain exposes a `session.models` directory and `session.selectModel`. The directory is built dynamically from the LLM registry and grouped by provider; each listed model's exact metadata adds adapter-owned reasoning effort ids, context tiers, names, descriptions, active state, selectability, and optional defaults. Provider catalogs and exact metadata load concurrently by provider and fail independently, so successful groups remain usable alongside retryable failure records. Catalog membership stays advisory: `session.models.current` is returned independently and can remain routable when absent from every group, but the Host does not synthesize an unlisted row after its provider stops advertising it. The two surfaces answer that state differently: the TUI renders the unlisted current model as its own row, while Web shows the unset trigger label and asks for a replacement. Web is the surface where a catalog is edited, so an absent row presents a selection decision; the TUI only picks from existing rows. A Web composer showing the unset label can still send with its current routable selection. Exact resolution decides whether a provider/model pair and explicit context or effort are available. Selection uses `resolveCallConfig` to reject unsupported values and materialize adapter-configured defaults before assigning the selection.

The browser `ModelDirectoryResolver` owns one `ModelDirectory` per live session. Its snapshot contains the current complete `ModelSelection`, grouped catalog, provider failures, operation error, and `idle`/`loading`/`ready`/`selecting`/`error` state. Mounting primes the trigger label and each menu open refreshes the directory. Directory and selection calls share an operation generation so an older response cannot replace a newer result; connection reset discards the process-local projection before restoring the Host selection. Failures retain the previous selection and usable groups.

`@deepseek-ai/dsh-client-ui-conversation` declares the session-scoped single slot `conversation.input.model` as a child of its composer-bar entry. InputBar renders the seat in its trailing controls immediately before the pending indicator and primary button; the seat receives the bar's `locked` owner prop and session scope. `@deepseek-ai/dsh-client-ui-model-selection` occupies that seat and also contributes `/model` over the same directory. Three sibling one-click triggers expose Model, Context, and Effort without nested selector menus. The model menu groups endpoint rows by provider, mutes non-selectable capacity rows, and marks active rows. The context menu shows only the selected model's endpoint entries. An entry marked unavailable remains selectable with an orange reason/risk warning and submits the explicit best-try override; an ordinary context selection omits that override. For an advertised selection, Effort is always visible: it shows only that model's exact levels and default, or is disabled with an explanatory tooltip when reasoning metadata is absent. When the current selection is absent from the groups, the model trigger displays `Select model`, the model list marks no row selected, and capability controls stay absent because support is unknown; choosing a listed model assigns the complete selection through the shared selection path. The provider-default effort row appears only when the adapter does not configure a model default.

The production browser roster is assembled from `apps/cli/config/base.cordis.yml` plus `apps/cli/config/web.cordis.yml`; the model feature is one `dsh.client` row rather than a package hardcoded in Web boot code. Its package manifest orders it after the runtime and command feature, while Cordis service injection waits for the conversation slot before registering the composer occupant.

## Alternatives considered

**Use separate provider and model dropdowns.** The model list depends on the provider and repeats a two-stage interaction for every change. One grouped menu keeps the provider visible as organization without lengthening the trigger or each row.

**Hardcode the current DeepSeek catalog in the Web client.** This would drift from registered adapters and exclude deployment-owned providers. The LLM registry remains the source of provider and model metadata, including partial lookup failures.

**Keep `High`/`Max` as client-local UI state.** Static DeepSeek labels cannot represent `off`, pi-ai provider vocabularies, adapter defaults, validation, resume, or the next provider request. Exact-model metadata owns the selectable vocabulary, and the session selection owns the selected id.

**Use only a global default.** One shared value cannot preserve an existing session's logged route. An accepted ordinary selection updates `ctx.agentDefaultModel` for later blank or new sessions while the live session keeps its own complete selection; warned best-try overrides remain session-local.

**Reject changes while an Agent is running.** The atomic selection snapshot separates the assembled step from the next selection. Keeping the selector available lets the user prepare the following step without altering the in-flight request.

**Persist every click as a new session event.** A choice is not model-visible until prompt assembly consumes it. Persisting unused UI intent would add a durable event that does not reconstruct a model request; the existing `request/header` records the first request that actually uses the route.

## Consequences

Any Host-backed Web conversation, including a blank session, can switch among dynamically discovered provider groups and exact-model context/reasoning choices without displaying duplicated `provider/model` labels or choices owned by another model. The consumed selection survives resume and reconnect; catalog names remain presentation-only, while selection and persistence use provider/model/context/effort ids. A provider catalog or exact-metadata outage degrades only that group. Provider/model changes can reduce provider-side cache reuse, and warned best-try contexts may evict a resident endpoint model or fail, but the selector adds no prompt content and does not disturb the in-flight step. A model without reasoning metadata retains an explained disabled Effort control.

## Testing

Host tests pin grouped discovery, catalog and exact-metadata failure isolation, logged effort restoration without stale-row injection, advisory unlisted selection, unsupported effort rejection, default materialization, and next-assembly switching. Client tests pin the shared directory, reconnect restoration, complete-selection submission, and best-try transport. Component tests pin selected-model-only contexts and efforts, exact warned/ordinary selection payloads, dynamic effort labels, descriptions, provider-default exposure, and the disabled Effort fallback. A real-composition Web scenario serves endpoint metadata and exercises the same warning, no-bleed, best-try, ordinary, exact-effort, and unsupported-reasoning controls through the shipped browser/Host stack.
