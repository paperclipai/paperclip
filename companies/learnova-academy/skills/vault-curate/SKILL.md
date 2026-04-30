---
name: vault-curate
description: >
  Vault Historian's primary skill — daily/weekly/monthly curation of the
  Obsidian vault. Build by-date / by-agent / topics indices, detect orphans,
  validate wikilinks, archive >365d files, write weekly narrative timeline.
  Use when ticket lands assigned to @vault-historian.
---

# Vault Curate

Index, validate, archive. Never modify content.

## Scope

- Daily: indices + frontmatter check + orphan detection
- Weekly: timeline + topics map
- Monthly: health audit + archive sweep

## Inputs

- `vault/` root at `/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/vault/`
- `git log` for "modified in last N days"

## Workflow

### Daily (08:00 IST, ~5 min, ≤$0.30)

#### 1. List files modified in last 24h

```bash
find vault -type f -name "*.md" -mtime -1 -not -path "vault/_index/*" -not -path "vault/_archive/*"
```

#### 2. Frontmatter check

For each file, verify it has at minimum:
```yaml
---
date: YYYY-MM-DD
agent: <slug>     # or author: <slug>
type: research | course-draft | blog | decision | retrospective | ...
---
```

Missing → write to `vault/_audit/frontmatter-issues-<date>.md` (don't fix the file).

#### 3. Wikilink validation

For each `[[target]]` reference in the file:
```bash
grep -oE '\[\[[a-zA-Z0-9/-]+\]\]' "$file" | sort -u
```

Verify each target file exists in vault. Broken links → audit file.

#### 4. Orphan detection

```bash
# Find files that are NOT linked from any other file
for f in vault/**/*.md; do
  base=$(basename "$f" .md)
  if ! grep -rq "\[\[$base\]\]" vault/ --include="*.md"; then
    echo "ORPHAN: $f"
  fi
done
```

Orphan rate >10% → escalate.

#### 5. Update by-date index

`vault/_index/by-date.md`:
```markdown
# Vault timeline (newest first)

## 2026-04-30
- [[blogs/2026-04-30-anthropic-creative-connectors/draft]] — content-author (blog)
- [[research/_daily/2026-04-30]] — research-editor (synth)
- [[research/community/2026-04-30]] — researcher-community (vendor)
- ...

## 2026-04-29
- ...
```

#### 6. Update by-agent index

`vault/_index/by-agent.md`:
```markdown
# Vault by author

## ceo
- [[decisions/2026-04-30-v2-vertex-ai-enterprise-agents]]
- [[retrospectives/ceo/2026-04-30-daily-triage]]

## researcher-anthropic
- ...
```

#### 7. Update per-agent profiles

For each agent that wrote anything: `vault/_index/people/<slug>.md`:
```markdown
---
slug: <agent>
total_files: <N>
last_active: 2026-04-30
---

# <Agent name>

## Recent work (last 7 days)
- [[link]] - 2026-04-30 - title
- ...

## Best work (manual + auto-promoted)
- [[link]] - 2026-04-21 - "Why this stood out: <reason>"
```

#### Daily PASS comment

```
✅ Vault curate · 2026-04-30
- N files reviewed; M orphans; K broken links
- Indices updated: by-date.md, by-agent.md, people/<8 profiles>
- Audits: vault/_audit/frontmatter-issues-<date>.md (if any)
- Cost: $0.X
```

### Weekly (Mon 10:00 IST, ~15 min, ≤$1.00)

Generate `vault/_index/timeline-W<n>.md`:
```markdown
---
week: 17
year: 2026
historian: vault-historian
file_count: 42
agents_active: 12
---

# W17 timeline

## Shipped
- 1 blog (Anthropic 8 connectors) — KOE-4
- 1 cron-wiring (KOE-8) — chief-engineering

## Decisions
- [[decisions/2026-04-30-v2-vertex-ai-enterprise-agents]]: defer Vertex AI new course to V2

## Research peaks
- HOT 2026-04-30: Anthropic creative connectors
- HOT 2026-04-30: Claude Code billing bug

## Retros + SOUL changes proposed
- ceo: cron not wired (resolved by KOE-8)
- chief-content: dispatch chain healthy
```

Plus `vault/_index/topics.md` — tag-frequency table.

### Monthly (1st of month, ~30 min, ≤$2.00)

`vault/_audit/<date>-vault-health.md`:
```markdown
---
date: 2026-05-01
total_files: 412
orphan_rate: 3.2%
broken_links: 1.1%
stale_frontmatter: 0.5%
disk_usage: 4.2 MB
---

# Monthly vault health

## Trends
- File growth: +89 this month
- Top contributors: research-editor (38), content-author (24)
- Top tags: vendor/anthropic (54), course/claude-tool-use (12)

## Issues
- 13 orphans (acceptable)
- 4 broken wikilinks (created tickets KOE-15..18 to fix)

## Archive
- 0 files archived this month (vault still <1y old)

## SOUL update proposals
- obsidian-vault-write skill: stricter wikilink rule on cross-references
```

## Output

Indices in `vault/_index/`, audits in `vault/_audit/`, weekly timeline in `_index/`.

## Notes

- Don't modify other agents' files. Read-only.
- Don't delete — archive (move to `_archive/<year>/`).
- Use atomic writes (full file replace).
- Per-task cap $0.30 daily, $1 weekly, $2 monthly.

## Escalation

- Orphan rate >10% → propose obsidian-vault-write skill update
- Vault grows >100MB without proportional throughput → flag runaway agent
- Same broken link returning 3+ days → escalate to content-author
