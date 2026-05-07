---
name: gstack-retro
description: >
  Weekly engineering retrospective. Analyzes commit history, work patterns,
  and code quality metrics with persistent history and trend tracking.
  Team-aware: breaks down per-person contributions with praise and growth areas.
  Use when asked to "weekly retro", "what did we ship", or "engineering retrospective".
  Proactively suggest at the end of a work week or sprint.
---

# /gstack-retro — Weekly Engineering Retrospective

Generates a comprehensive engineering retrospective analyzing commit history, work patterns, and code quality metrics.

## Arguments

- `/retro` — default: last 7 days
- `/retro 24h` — last 24 hours
- `/retro 14d` — last 14 days
- `/retro 30d` — last 30 days
- `/retro compare` — compare current window vs prior same-length window

---

## Step 1: Gather Raw Data

First, detect the repo's default branch:
```bash
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
```

Identify the current user:
```bash
git config user.name
git config user.email
```

Run these git commands:

```bash
# All commits in window with details
git log origin/<default> --since="<window>" --format="%H|%aN|%ae|%ai|%s" --shortstat

# Per-commit file changes
git log origin/<default> --since="<window>" --format="COMMIT:%H|%aN" --numstat

# Commit timestamps for session detection
git log origin/<default> --since="<window>" --format="%at|%aN|%ai|%s" | sort -n

# Files most frequently changed
git log origin/<default> --since="<window>" --format="" --name-only | grep -v '^$' | sort | uniq -c | sort -rn

# Per-author commit counts
git shortlog origin/<default> --since="<window>" -sn --no-merges
```

---

## Step 2: Compute Metrics

Calculate and present these metrics:

| Metric | Value |
|--------|-------|
| Commits to main | N |
| Contributors | N |
| Total insertions | N |
| Total deletions | N |
| Net LOC added | N |
| Test LOC ratio | N% |
| Active days | N |
| Detected sessions | N |

Then show a **per-author leaderboard**:

```
Contributor         Commits   +/-          Top area
You (name)              32   +2400/-300   browse/
alice                   12   +800/-150    app/services/
```

---

## Step 3: Commit Time Distribution

Show hourly histogram in local time:

```
Hour  Commits
 00:    4      ████
 07:    5      █████
 ...
```

Identify peak hours, dead zones, and late-night coding clusters.

---

## Step 4: Work Session Detection

Detect sessions using **45-minute gap** threshold between consecutive commits.

Classify sessions:
- **Deep sessions** (50+ min)
- **Medium sessions** (20-50 min)
- **Micro sessions** (<20 min)

Calculate:
- Total active coding time
- Average session length
- LOC per hour

---

## Step 5: Commit Type Breakdown

Categorize by conventional commit prefix:

```
feat:     20  (40%)  ████████████████████
fix:      27  (54%)  ███████████████████████████
refactor:  2  ( 4%)  ██
```

Flag if fix ratio exceeds 50%.

---

## Step 6: Hotspot Analysis

Show top 10 most-changed files. Flag:
- Files changed 5+ times (churn hotspots)
- Test files vs production files

---

## Step 7: Focus Score + Ship of the Week

**Focus score:** Percentage of commits touching the single most-changed top-level directory.

**Ship of the week:** Single highest-LOC PR. Highlight:
- PR number and title
- LOC changed
- Why it matters

---

## Step 8: Team Member Analysis

For each contributor:

1. **Commits and LOC**
2. **Areas of focus** — top 3 directories
3. **Commit type mix**
4. **Session patterns** — peak hours
5. **Test discipline** — personal test LOC ratio
6. **Biggest ship** — highest-impact commit

**Praise:** 1-2 specific things anchored in commits
**Opportunity for growth:** 1 specific, constructive suggestion

---

## Step 9: Streak Tracking

Count consecutive days with at least 1 commit:
- Team shipping streak
- Your personal streak

---

## Step 10: Load History & Compare

Check for prior retro history:
```bash
ls -t .context/retros/*.json 2>/dev/null
```

If prior retros exist, calculate deltas for key metrics.

---

## Step 11: Save Retro History

Save a JSON snapshot to `.context/retros/{date}-{sequence}.json`:

```json
{
  "date": "2026-03-08",
  "window": "7d",
  "metrics": {
    "commits": 47,
    "contributors": 3,
    "insertions": 3200,
    "deletions": 800,
    "test_ratio": 0.41,
    "sessions": 14
  },
  "authors": {
    "Name": { "commits": 32, "insertions": 2400, "top_area": "browse/" }
  },
  "streak_days": 47
}
```

---

## Step 12: Write the Narrative

Structure the output:

### Tweetable summary
```
Week of Mar 1: 47 commits (3 contributors), 3.2k LOC, 38% tests, 12 PRs, peak: 10pm | Streak: 47d
```

### Summary Table

### Time & Session Patterns

### Shipping Velocity

### Code Quality Signals

### Focus & Highlights

### Your Week (personal deep-dive)

### Team Breakdown

### Top 3 Team Wins

### 3 Things to Improve

### 3 Habits for Next Week

---

## Compare Mode

When running `/retro compare`:
1. Compute metrics for current window
2. Compute metrics for prior same-length window
3. Show side-by-side comparison with deltas

---

## Important Rules

- ALL narrative output goes directly to the user
- The ONLY file written is the `.context/retros/` JSON snapshot
- Use `origin/<default>` for all git queries
- Display timestamps in user's local timezone
- If zero commits in window, suggest different window
- On first run, skip comparison sections
