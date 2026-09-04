# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

This package fills `sidebar.brand.name` with the plain `Vortex Harness` name only when `DSH_CLIENT_BUILD_PROFILE` is `official`. Other builds load the plugin but register no occupant, leaving the shell fallback visible.

The occupant installs through `slots.inject()`, so it works whether its row activates before or after the sidebar declarer and withdraws when that declaration collapses. It retains no runtime state. The node half is an empty Loader seat, and the browser title remains a build-environment concern outside this package.

## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The package supplies one name occupant** — alternative presentation belongs in another Cordis package occupying the same slot.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.
