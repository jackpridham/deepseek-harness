# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, translate, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change relocates the English note and inserts `Archived: YYYY-MM-DD` below `Status: implemented`. Pre-existing translation or sidecar files may move with it unchanged, but they are optional and must not be created or updated for archival. Repair or delete inbound links; do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, companion files without an English note, unknown kind folders, and invalid English archive metadata.
