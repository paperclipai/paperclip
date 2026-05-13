# Forking paperclip → Odysseus

## Status: linked

The fork lives at **https://github.com/PossibLaw/odysseus**.

The local clone at `/Users/salvadorcarranza/odysseus-fork/` has been re-pointed:

```
origin    → https://github.com/PossibLaw/odysseus.git    (your fork, push target)
upstream  → https://github.com/paperclipai/paperclip     (paperclip, pull source)
```

## Daily workflow

```bash
cd /Users/salvadorcarranza/odysseus-fork

# PossibLaw/odysseus is already populated (GitHub-fork mirrors paperclip's master).
# Routine: pull paperclip's updates into your fork:
git fetch upstream
git checkout master
git merge upstream/master
git push origin master

# Routine: work on a feature branch:
git checkout -b sprint-0/rebrand
# ... edits ...
git push -u origin sprint-0/rebrand
# open a PR against PossibLaw/odysseus on GitHub
```

## License posture

- Paperclip is MIT.
- Odysseus ships as **Apache 2.0** — matches Anthropic's 12 practice-area plugins; explicit patent grant suits a legal product. Sprint 0 swaps the `LICENSE` file and adds a `NOTICE` preserving paperclip's MIT origin attribution.
- Mike-derived skills (tabular review, docx tracked changes, docx generation, clause extraction presets, CP checklist, credit/SHA summarizers) are pattern extractions with attribution, not code copies. If we ever copy AGPL-3.0 code from mike, it gets segregated as an AGPL sub-package.

## What happens next (sprint 0)

Once the fork is set up, sprint 0 of the plan calls for:

1. Bulk rename `paperclip` → `odysseus` across the TS codebase (CLI binary name, `package.json` name, UI brand, docs).
2. Strip paperclip's engineering-role definitions; replace with Odysseus's `agents/`, `skills/legal/`, `profiles/`, `risk-gates/`, `mcp/`.
3. Add `server/src/domaster/legal/` models + Postgres migrations.
4. Move the legal-layer artifacts currently in `/Users/salvadorcarranza/Odysseus/` into the forked repo so they ship together.
5. Update `docker-compose.yml` to remove the now-unnecessary host-mounts of `agents/`, `skills/`, etc.
6. Push to your fork and open a draft PR (against your own `master` from a `sprint-0/rebrand` branch) so the bulk rename is reviewable.

## Why a hard fork

The plan explicitly chose **hard fork** over soft fork (upstream + plugin layer). Reasons:
- paperclip's role-set assumptions (eng PM / eng / QA / sec) bleed into the UI, the seed data, the heartbeat logic, and the governance prompts. A soft fork would require monkey-patching all of them.
- We want full ownership of the brand and the CLI.
- We are willing to take on the merge-debt of pulling upstream changes manually.

If that ever stops being worth it, the move is to extract Odysseus's legal layer back into a plugin and switch to soft-fork — at that point the upstream/origin distinction we set up above keeps the door open.

## License

paperclip is MIT. Odysseus inherits MIT. The mike-derived skills (tabular review, docx tracked changes, docx generation, clause extraction presets, CP checklist, credit/SHA summarizers) are **pattern extractions** from an AGPL-3.0 codebase, not code copies — they reproduce the structural workflow with attribution. If we ever copy code (e.g., the docx tracked-changes implementation in `backend/src/lib/docxTrackedChanges.ts`), that file would be AGPL-3.0 and the Odysseus build would need to treat it accordingly (likely segregate to a separately-licensed sub-package, or re-implement clean-room).
