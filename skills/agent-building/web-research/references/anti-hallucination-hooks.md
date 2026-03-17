# Anti-Hallucination Hooks

Two hooks work together: one logs every source at fetch time, one loads prior research at session start.

---

## Hook 1: PostToolUse WebFetch Source Logger

Appends every WebFetch URL to `~/.claude/source-log.md` with a timestamp. After any research session, this file is the ground truth for "what Claude actually fetched."

**`~/.claude/hooks/source-log.sh`:**

```bash
#!/bin/bash
# PostToolUse hook — fires after every WebFetch call
# Appends the fetched URL to the session source log

TOOL_NAME="${TOOL_NAME:-}"
TOOL_INPUT="${TOOL_INPUT:-}"
SOURCE_LOG="$HOME/.claude/source-log.md"

# Only process WebFetch calls
if [ "$TOOL_NAME" != "WebFetch" ]; then
  exit 0
fi

# Extract URL from tool input (JSON)
URL=$(echo "$TOOL_INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('url','unknown'))" 2>/dev/null)
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SESSION_DATE=$(date +"%Y-%m-%d")

# Initialize source log if needed
if [ ! -f "$SOURCE_LOG" ]; then
  echo "# Source Log" > "$SOURCE_LOG"
  echo "" >> "$SOURCE_LOG"
fi

# Append the entry
echo "- $URL — fetched $TIMESTAMP" >> "$SOURCE_LOG"

exit 0
```

**Install:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "WebFetch",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/source-log.sh"}]
      }
    ]
  }
}
```

---

## Hook 2: SessionStart Research Loader

On session start, scans `~/.claude/research/` for reports matching keywords in the current working directory or recent conversation context. Prepends matching reports as context, preventing repeat fetches.

**`~/.claude/hooks/load-research.sh`:**

```bash
#!/bin/bash
# SessionStart hook — loads prior research reports for the current project

RESEARCH_DIR="$HOME/.claude/research"
CWD_PROJECT=$(basename "$PWD")

# Create research dir if it doesn't exist
mkdir -p "$RESEARCH_DIR"

# Find reports matching current project name
MATCHING=$(ls "$RESEARCH_DIR"/*${CWD_PROJECT}*.md 2>/dev/null)

if [ -n "$MATCHING" ]; then
  echo "## Prior Research Loaded"
  echo ""
  for f in $MATCHING; do
    echo "### $(basename $f)"
    cat "$f"
    echo ""
  done
fi

exit 0
```

**Install:**
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/load-research.sh"}]
      }
    ]
  }
}
```

---

## Source Log Format

`~/.claude/source-log.md` — auto-maintained by the PostToolUse hook:

```markdown
# Source Log

- https://reactjs.org/blog/2024/04/25/react-19.html — fetched 2026-03-17T14:32:01Z
- https://github.com/facebook/react/releases/tag/v19.0.0 — fetched 2026-03-17T14:33:18Z
- https://vercel.com/blog/our-experience-upgrading-next-js-to-react-19 — fetched 2026-03-17T14:35:44Z
```

---

## Hallucination Detection Workflow

After any research session, run this check:

```
Compare the URLs cited in [research-report.md] against ~/.claude/source-log.md.
List any URL that appears in the report but is NOT in source-log.md.
These are hallucinated citations — Claude cited them without fetching them.
```

Any URL in a research report that doesn't appear in source-log.md is a hallucination. Remove it or fetch the actual URL to verify.

---

## Resetting the Source Log

The source log is cumulative across sessions. To start a clean log for a new research project:

```bash
# Archive the current log
cp ~/.claude/source-log.md ~/.claude/source-log-$(date +%Y%m%d).md
# Reset
echo "# Source Log" > ~/.claude/source-log.md
```

Or add a date-stamped header at the start of each research session:

```
Please add a session header "## Research Session: [topic] — [date]" to ~/.claude/source-log.md before beginning.
```
