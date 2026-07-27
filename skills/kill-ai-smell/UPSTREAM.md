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

`SKILL.md` — two changes:

1. The frontmatter `description` was trimmed from 341 to 242 characters to fit the skills-repo lint limit (`scripts/skill-lint` `DESC_LIMIT = 250`), keeping the trigger keywords (AI smell, AI tells, slop, em dashes).
2. **Split for progressive disclosure (2026-07-27, Luke-approved)**, superseding the earlier keep-inline exception: the complete rule body (all sections with Bad/Good pairs, from "Punctuation" through "Where the rules come from") moved **verbatim** to `references/full-ruleset.md`. SKILL.md now carries the intro/principle paragraphs verbatim plus a compact rule index that preserves every measured budget `check.py` enforces (em-dash 1/1k, semicolon chain/3-per-1k, colon-pivot streak of 3, contrast + "not just" bans, triads 3/1k, anaphora, hedging, transitions, fragments 15%, sentence-flow run ≥10, labeled bullets 30%, MTLD 110, heading rules) and a router to the full ruleset.

`check.py`, `evidence.md` remain **verbatim**; the checker reads drafts, not SKILL.md, so the split does not affect enforcement.

## House style note

Unlike the retired `stop-slop`, this skill is adopted **strict** (Luke's call, 2026-07-14): the em-dash budget and all other rules apply as written, including in terse and technical writing. There is no em-dash / adverb / wh-starter carve-out. Run `check.py` on drafts and restructure until clean.

## Refresh from upstream

```bash
cd /tmp && rm -rf tools-refresh && gh repo clone osolmaz/tools tools-refresh -- --depth 1
SRC=/tmp/tools-refresh/agents/skills/kill-ai-smell
# check.py + evidence.md are verbatim — diffs should be empty unless upstream changed them:
diff -u "$SRC/check.py"    ~/Projects/personal/skills/kill-ai-smell/check.py
diff -u "$SRC/evidence.md" ~/Projects/personal/skills/kill-ai-smell/evidence.md
# The rule body now lives verbatim in references/full-ruleset.md (from "## Punctuation" onward).
# Diff upstream's body against it; the intro paragraphs are verbatim in SKILL.md:
diff -u <(sed -n '/^## Punctuation/,$p' "$SRC/SKILL.md") <(sed -n '/^## Punctuation/,$p' ~/Projects/personal/skills/kill-ai-smell/references/full-ruleset.md)
# On upstream rule changes: update full-ruleset.md verbatim AND mirror any new/changed
# rule + budget into the SKILL.md compact index. Then bump the "Vendored" date above.
```
