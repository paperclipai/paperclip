# Upstream

- Skill source: https://github.com/osolmaz/tools (`agents/skills/kill-ai-smell/`)
- Evidence/study: https://github.com/osolmaz/ai-smell (MIT) — write-up at https://solmaz.io/ai-de-smeller
- Author: Onur Solmaz (https://solmaz.io)
- Vendored: 2026-07-14 from `osolmaz/tools` HEAD (SKILL.md, check.py, evidence.md)

## License

`osolmaz/tools` ships no top-level LICENSE, so the skill text carries no explicit grant; vendored here for Luke's internal agent use with attribution to the author. The measurements the rules rest on come from `osolmaz/ai-smell`, which is MIT. If this skill is ever redistributed publicly, confirm a license with the author first.

## Why vendored

Replaces the previous prose anti-slop skill `stop-slop` (hardikpandya). `kill-ai-smell` is more rigorous: measured thresholds from a stylometric corpus, deeper coverage (openings, headings, page structure, paragraph shape), and a stdlib mechanical checker (`check.py`) that flags violations and exits nonzero. Referenced from `go` (PR-body pass) and `docs-freshness-pr` (doc rewrites).

## Divergence from upstream

`check.py`, `evidence.md` — **verbatim**.

`SKILL.md` — one change: the frontmatter `description` was trimmed from 341 to 242 characters to fit the skills-repo lint limit (`scripts/skill-lint` `DESC_LIMIT = 250`), keeping the trigger keywords (AI smell, AI tells, slop, em dashes). The rule body is verbatim.

Body length: SKILL.md is ~450 lines, over the repo's `BODY_LIMIT = 120`. This is an accepted exception recorded in `scripts/skill-budget-baseline.json` (`body`), because the value of this skill is the complete measured ruleset kept inline; splitting it into `references/` risks dropping rules the checker assumes are present.

## House style note

Unlike the retired `stop-slop`, this skill is adopted **strict** (Luke's call, 2026-07-14): the em-dash budget and all other rules apply as written, including in terse and technical writing. There is no em-dash / adverb / wh-starter carve-out. Run `check.py` on drafts and restructure until clean.

## Refresh from upstream

```bash
cd /tmp && rm -rf tools-refresh && gh repo clone osolmaz/tools tools-refresh -- --depth 1
SRC=/tmp/tools-refresh/agents/skills/kill-ai-smell
# check.py + evidence.md are verbatim — diffs should be empty unless upstream changed them:
diff -u "$SRC/check.py"    ~/Projects/personal/skills/kill-ai-smell/check.py
diff -u "$SRC/evidence.md" ~/Projects/personal/skills/kill-ai-smell/evidence.md
# SKILL.md diverges only in the frontmatter description — review upstream changes and re-apply the trim:
diff -u "$SRC/SKILL.md"    ~/Projects/personal/skills/kill-ai-smell/SKILL.md
# Then bump the "Vendored" date above.
```
