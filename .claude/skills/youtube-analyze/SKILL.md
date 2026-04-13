---
name: youtube-analyze
description: Use when you need to analyze a YouTube video for Darwin/Paperclip relevance. Takes pre-extracted metadata and transcript (from the youtube-research skill) and produces a structured research report with a HIGHLY RECOMMENDED / WORTH EXPLORING / NOT RELEVANT verdict. Designed specifically for Darwin's Paperclip AI orchestration platform context. Also handles writing the report to the Obsidian vault.
---

# YouTube Analyze

Analyze a YouTube video for Darwin relevance and produce a structured research report. This skill assumes you already have metadata and a transcript — use the `youtube-research` skill first if you don't.

## Prerequisites

```bash
claude --version   # Claude CLI must be on PATH
```

## The Analysis Prompt

Use this exact prompt template with `claude -p`. Replace placeholders with real values:

```
You are a technical research analyst for Darwin, a company building Paperclip — an AI agent orchestration and project management platform.

Analyze the following YouTube video and produce a structured research report. Your goal is to determine whether the content is worth implementing or adapting for the Paperclip system.

## Video Info
Title: {title}
Channel: {channel}
Duration: {duration}
Views: {view_count}

## Description
{description — first 2000 chars}

## Transcript
{transcript — first 8000 chars, or "(no transcript available)"}

## Your Task

Produce a markdown report with these exact sections:

### Summary
2-4 sentences describing what this video is actually about.

### Key Items Extracted
Numbered list of every distinct tool, technique, tip, feature, or concept mentioned. One-sentence description for each.

### Relevance Assessment
For each key item above, rate relevance to Paperclip (AI agent orchestration, project management, developer productivity tools) as HIGH / MEDIUM / LOW. One sentence explanation.

### Top Recommendations
The 3-5 items most worth exploring for Paperclip. For each: what specifically we would implement and why.

### Verdict
One of: HIGHLY RECOMMENDED / WORTH EXPLORING / NOT RELEVANT
One sentence justification.
```

## Running the Analysis

```bash
REPORT=$(claude -p "$PROMPT" --dangerously-skip-permissions --output-format text)
```

Timeout: 180 seconds. Output is a full markdown report string.

## Output Structure

The report contains:
- `### Summary` — what the video is about
- `### Key Items Extracted` — numbered list of tools/techniques/concepts
- `### Relevance Assessment` — HIGH / MEDIUM / LOW rating per item
- `### Top Recommendations` — 3-5 actionable items for Paperclip
- `### Verdict` — one of:
  - `HIGHLY RECOMMENDED` — multiple high-relevance items, strong implementation fit
  - `WORTH EXPLORING` — some relevant ideas worth deeper investigation
  - `NOT RELEVANT` — content does not align with Paperclip's direction

## Writing to the Obsidian Vault

After analysis, write the report to:
```
/home/r1kon/.paperclip/instances/default/paperclip-wiki/outputs/youtube-extractions/{YYYY-MM-DD}-{video_id}.md
```

Use this format:

```markdown
---
title: "{video title}"
channel: "{channel name}"
url: "{youtube url}"
video_id: "{video id}"
analyzed: YYYY-MM-DD
verdict: HIGHLY RECOMMENDED
tags: [youtube-extraction, ai-tools]
---

# {video title}

**Channel:** {channel} · **Duration:** {Xm Ys} · **Views:** {N views}
**URL:** {url}
**Analyzed:** {YYYY-MM-DD}

---

{full report body}
```

Create the folder on first use:
```bash
mkdir -p /home/r1kon/.paperclip/instances/default/paperclip-wiki/outputs/youtube-extractions
```

## Integration with Daily Monitor

When running the daily YouTube monitor pipeline:

1. Use `youtube-research` to extract metadata + transcript for each new video
2. Use **this skill** to run the Claude analysis and get the verdict
3. Write the vault note (see above)
4. Include verdict badge + top recommendations in the daily digest

This ensures every analyzed video is permanently stored in the vault and searchable via the Obsidian MCP server.

## Deduplication (Required for Scheduled Tasks)

Before running any extraction, check whether the video has already been processed.

**Option A — API (preferred):** Submit via the POST endpoint. It checks automatically and returns the existing row with `alreadyExtracted: true` if a non-failed record exists. No extra work needed.

**Option B — Manual check:**
```bash
curl -s "$PAPERCLIP_API_URL/api/companies/$COMPANY_ID/youtube-extractions" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  | python3 -c "
import sys, json
rows = json.load(sys.stdin)
video_id = 'VIDEO_ID_HERE'
existing = [r for r in rows if r.get('videoId') == video_id and r.get('status') != 'failed']
print('SKIP' if existing else 'PROCEED')
"
```

**Rules:**
- `completed` → skip, use existing report from DB or vault note
- `processing` → skip, check back later
- `failed` → re-extract (failures are always retried)
- `missing` → proceed with extraction

The vault note at `outputs/youtube-extractions/{date}-{videoId}.md` also serves as a quick file-based confirmation that extraction succeeded.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Transcript too long | Truncate to first 8000 chars in the prompt |
| Description cut off | Truncate to first 2000 chars |
| Verdict string not found | Ensure report contains one of the 3 exact strings |
| Vault path missing | `mkdir -p` the directory before writing |
| `claude` not found | Verify with `which claude`; check PATH |
| Re-extracting known videos | Always check dedup before submitting (see above) |
