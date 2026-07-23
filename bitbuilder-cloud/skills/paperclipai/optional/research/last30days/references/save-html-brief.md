# Save shareable HTML brief

This reference file is loaded by the main `SKILL.md` when the user asked for an HTML brief (either explicitly via `--emit=html` / `--emit:html` / `--html`, or in natural language - "give me a shareable HTML brief", "for Slack", "for Notion", "export as HTML", etc.). The detection happens in `SKILL.md` so that the common no-HTML path stays short; the implementation lives here.

The contract: the synthesis still appears in chat as the primary output. The HTML is an additional artifact saved to disk for sharing. Both happen in the same turn.

## When to fire this flow

- After you have already emitted the full chat response: badge, "What I learned:" (or comparison title), bold-lead-in paragraphs with citations, KEY PATTERNS list, engine footer pass-through, invitation block.
- BEFORE the WAIT FOR USER'S RESPONSE pause.
- ONLY if the user asked. Do NOT save HTML when the user didn't ask for it.

## How to fire it

```bash
# 1. Write your synthesis prose VERBATIM to a temp file. The synthesis is the
#    "What I learned:" prose label, the bold-lead-in paragraphs with their
#    inline citations as you wrote them in chat, and the "KEY PATTERNS from
#    the research:" numbered list. Do NOT include the badge or the engine
#    footer in the temp file - the engine adds those when it renders the HTML.
#    Use the EXACT text you just wrote in chat. Do not paraphrase, do not
#    summarize, do not reorder. The HTML must read identically to the chat
#    response in voice and citations.
SYNTHESIS_FILE="/tmp/last30days-synthesis-${CLAUDE_SESSION_ID}.md"
cat > "$SYNTHESIS_FILE" <<'SYNTHESIS_EOF'
What I learned:

**{First headline}** - {body with [name](url) inline citations}

**{Second headline}** - {body}

**{Third headline}** - {body}

KEY PATTERNS from the research:
1. {pattern} - per [@handle](url)
2. {pattern} - per [r/sub](url)
3. {pattern} - per [@handle](url)
SYNTHESIS_EOF

# 2. Convert the synthesis to a self-contained HTML file via the engine.
#    The engine reuses the cache from your earlier engine run (same topic
#    + plan), so this second invocation is typically <1s on cache hit.
SLUG=$(echo "$TOPIC" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
HTML_PATH="${LAST30DAYS_MEMORY_DIR}/${SLUG}-brief.html"
"${LAST30DAYS_PYTHON}" "${SKILL_ROOT}/scripts/last30days.py" "${TOPIC}" \
  --emit=html \
  --synthesis-file "$SYNTHESIS_FILE" \
  > "$HTML_PATH"

# 3. Append ONE line to your already-emitted chat response, after the
#    invitation block. Use a paperclip emoji as a visible signal that an
#    artifact was produced:
echo "📎 Shareable brief saved to $HTML_PATH"
```

## What ends up in the HTML file

The engine's `--emit=html` renderer combines:

- The badge (`🌐 last30days vX.Y.Z · synced YYYY-MM-DD`) at the top
- A single inline metadata line (`{date range} · {active sources}`) below the badge
- Your synthesis verbatim, with prose labels promoted to `<h2>` and bold lead-ins preserved
- All `[name](url)` citations rendered as `<a>` tags
- The engine footer (`✅ All agents reported back!` tree) preserved verbatim in monospace
- A colophon with the topic and a re-run hint

The renderer strips engine-internal noise that doesn't belong in a shareable artifact: the `# last30days vX.Y.Z: TOPIC` debug file header, the model-facing `> Safety note:` blockquote, and the `I'm now an expert on X` invitation block. Data quality warnings (degraded run, thin evidence, etc.) stay in the engine's stderr logs - they never leak into the share-ready file.

## Comparison mode

Same flow when the topic is `X vs Y` (or `X vs Y vs Z`). The engine routes through `render_for_html_comparison` internally; you don't need to do anything special. The synthesis temp file should still contain the comparison-shaped synthesis you wrote in chat (`## Quick Verdict`, `## {Entity}` per entity, `## Head-to-Head` table, `## The Bottom Line`, `## The emerging stack` per LAW 4 comparison exception).

## Follow-up turn

If the user runs `/last30days OpenClaw` normally, sees the synthesis in chat, and THEN says "save that as HTML" or "give me a shareable version" in a follow-up turn, do the same save flow on the synthesis you wrote in the previous turn. Do not re-research; the synthesis is already in the conversation history. Just write it to the temp file and call the engine with `--emit=html --synthesis-file`.

## What NOT to do

- Do NOT save HTML if the user didn't ask. The sparse mode (no synthesis) produces a thin file; not useful as a shareable.
- Do NOT add content to the temp file beyond your synthesis prose. The badge / footer / colophon come from the engine.
- Do NOT change the file path convention. `${LAST30DAYS_MEMORY_DIR}/${SLUG}-brief.html` is the canonical location.
- Do NOT silently overwrite an existing file without telling the user. If `$HTML_PATH` already exists from a prior run, the engine will pick a date-suffixed name (`{slug}-brief-YYYY-MM-DD.html`) automatically; just print whichever path the redirect produced.
- Do NOT include the data quality warning text in the temp file or in your final chat line. Warnings are an engine-stderr concern, not an artifact concern.

## Edge cases

- **Topic with shell-special characters** (quotes, ampersands): the temp filename uses a slugified version, but the engine receives the raw topic. The `cat <<'SYNTHESIS_EOF'` quoted heredoc form handles arbitrary content without expansion. Your synthesis text can include any character.
- **Very long synthesis**: no upper bound. The engine handles long markdown bodies. Just paste verbatim.
- **Synthesis with images or non-ASCII**: emoji and Unicode pass through. Image tags pass through as raw HTML; the renderer doesn't transform them. If you didn't include images in chat, don't add them here.
- **No `${LAST30DAYS_MEMORY_DIR}` set**: defaults to `~/Documents/Last30Days/` per the SKILL.md `Configuration` section.
