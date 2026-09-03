# Agent Note: English-only documentation maintenance

Status: implemented

## Problem

The repository required ordinary code and documentation changes to create or update Simplified Chinese companion files, consistency records, generated regions, and archive triplets. That obligation duplicated documentation the maintainer does not use and made unrelated development depend on translation work.

## Decision

English is the maintained documentation language. Ordinary work updates English Markdown, README files, JSDoc, generated references, and website sources without creating or updating `.zh.md` companions or `.i18n.yaml` records. Existing translations may remain as historical content and may still be published, but they are not current authority and may be stale.

The repository-wide `doc-sync` gate and Git hooks do not run the translation-pairing verifier. Source-derived documentation checks ignore optional Chinese code fences, and the Cordis catalog generator updates English pages only. Agent Note archival requires an English note; pre-existing translation and sidecar artifacts may move unchanged and remain sealed, but they are not required for a new archive entry.

Translation tooling remains available only for explicit user requests. A requested pair may use the existing translation rules, terminology, briefing, and scoped consistency verifier, but an English edit never implies that workflow.

This decision supersedes the maintenance obligations in [bilingual documentation and pairing](2026-07-02-bilingual-docs-and-pairing-gate.md), [briefed minimal translation updates](2026-07-26-briefed-minimal-translation-updates.md), [lightweight routine translation](2026-08-08-lightweight-routine-documentation-translation.md), and [automatic translation-pairing merges](2026-08-08-automatic-translation-pairing-merges.md). Their implementation history remains useful for the optional tooling they describe, but none requires companion maintenance.

## Alternatives considered

- **Keep mandatory pairs but avoid the extended skill** — rejected because direct translation still duplicates every maintained documentation change.
- **Delete every existing translation and translation tool immediately** — rejected because removing historical content and optional capabilities is separate from removing the maintenance obligation.
- **Require translations only for website pages or generated references** — rejected because those exceptions would continue to make English product work depend on Chinese companion maintenance.

## Consequences

English documentation and generated references can evolve independently. Existing Chinese pages may drift until a user explicitly requests translation or site-locale cleanup. Reviewers do not block an English change for missing, stale, or unrecorded Chinese companions.
