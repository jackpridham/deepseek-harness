# Agent Note: Vortex browser identity

Status: implemented

## Problem

The deployed browser surface inherited DeepSeek artwork, an exploratory headline and Preview badge, a first-load internal-testing notice, and a DeepSeek Harness document title. Those product-wide defaults obscured the deployment's Vortex identity and interrupted an operator before they could use the configured inf01 provider.

## Decision

The browser identifies itself as Vortex Harness in the initial document, dynamic session title, install manifest, and expanded Sidebar. The Sidebar renders no product mark, and its collapsed rail uses the ordinary panel control. The blank conversation keeps its composer, workspace chooser, and backdrop without a brand mark, headline, or Preview badge.

The settings-models plugin does not register the versioned internal-testing notice. Provider credential onboarding remains independently available when the configured provider is not ready; the generic onboarding coordinator and the dormant acknowledgement implementation remain reusable infrastructure rather than visible first-load product copy.

This decision supersedes the visible welcome step in the [versioned GUI onboarding decision](../feature/2026-07-30-versioned-gui-welcome-onboarding.md). It also removes and historically archives the [Web Preview badge decision](../../archived/feature/2026-08-05-web-preview-product-badge.md), whose product-lifecycle identity no longer applies to this surface.

## Alternatives considered

**Retain official artwork beside a Vortex title.** Rejected because the resulting mixed identity still presents the deployment as a DeepSeek product in navigation and empty-conversation chrome.

**Replace the removed hero with a Vortex logo and slogan.** Rejected because the requested surface needs a usable composer, not new decorative branding. The smaller shell also avoids another product-specific asset and copy contract.

**Keep the testing notice with revised Vortex copy.** Rejected because the requirement is to remove the first-load interruption, not merely rename it. Provider readiness still has its own actionable onboarding step.

## Verification

Component tests pin the Vortex fallback name and document title, the plain collapsed Sidebar control, the headline-free conversation hero, and the absence of a registered welcome step. The Web manifest test pins its installed name. Built browser replay covers the assembled surface without DeepSeek artwork, Preview copy, or the internal-testing modal.

## Consequences

The deployed Web surface has one Vortex identity and less first-load chrome. It gives up the upstream product mark, preview disclosure, and generic testing-stage acknowledgement. Reintroducing any of those elements requires a new product-identity decision rather than a deployment toggle; credential readiness remains an actionable, provider-owned dialog.
