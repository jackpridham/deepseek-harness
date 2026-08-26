# Optional documentation translations

English is the maintained documentation language in this repository. Existing Simplified Chinese `.zh.md` files and `.i18n.yaml` consistency records may remain as historical or user-requested translations, but ordinary development does not create, update, re-record, or require them.

The repository-wide documentation gate does not check translation completeness or synchronization. An English documentation change is complete when the maintained English source and its ordinary documentation checks pass, even when an existing translation is unchanged or absent.

## Explicit translation work

Use [`dsh-translate-docs`](../../.agents/skills/dsh-translate-docs/SKILL.md) only when the user explicitly requests a translation or names that skill. The optional workflow may use the existing sibling layout:

- English source: `foo.md`
- Simplified Chinese translation: `foo.zh.md`
- Optional consistency record: `foo.i18n.yaml`

For that explicitly named pair, [translation-rules.md](translation-rules.md) defines fidelity and structure, and [terminology.md](terminology.md) defines preferred terms. `pnpm run verify-translation-pairing <pair>` and its `--write` form remain available as scoped translation utilities; their corpus-wide output is informational and is not a merge requirement.

Do not infer translation work from an English edit, a nearby `.zh.md` file, a language switcher, or a stale consistency record. Do not create a Chinese counterpart to satisfy symmetry, website routing, an Agent Note lifecycle action, a generated-reference update, or a review request unless the user asked for that translation.

## Existing translations

Existing translations may continue to appear in the documentation website and may retain their language switchers. They do not carry equal maintenance authority with the English source and may be stale. A separate, explicitly authorized site-locale change may remove or remap them; ordinary English documentation work leaves them untouched.

When deleting or renaming an English document, remove or relocate any existing companion files only to prevent orphaned files. This cleanup does not require translating, reviewing, or re-recording their contents.

Frozen files under `.agents/notes/archived/` remain immutable. The archive verifier seals every artifact already present, but it requires only the English Agent Note for a new archive entry.
