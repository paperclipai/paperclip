---
name: html-report
description: >
  Generate polished, self-contained HTML reports (single file, inline CSS,
  zero JavaScript, zero external resources) and attach them to a Paperclip
  issue. Use when the user asks for a report, writeup, analysis, executive
  summary, or anything that benefits from typography, sections, tables and
  figures beyond plain markdown. Do NOT use for short issue comments — those
  must stay markdown.
---

# html-report Skill

Turn a structured JSON description into a beautiful, print-ready HTML file
and attach it to the current issue. The output is a single self-contained
`.html` document with inline CSS, no JavaScript, no external resources —
open it in any browser, print it to PDF, archive it, email it. It works the
same six months from now on an air-gapped machine.

## When to use

- The user asks for a "report", "отчёт", "writeup", "ресёрч", "analysis",
  "executive summary", "brief", "дашборд", "справка", "документ".
- The result has enough structure that a markdown comment would not do it
  justice: multiple sections, tables, figures, callouts.
- The result is an archival artifact the user wants to forward outside
  Paperclip (print to PDF, send to a colleague, attach to an email).

## When NOT to use

- **Short updates or replies.** Leave those in the issue comment as
  markdown — do not make a comment where every reply is a downloadable file.
- **Interactive dashboards** (sortable tables, live charts, date pickers).
  These require JavaScript, which the skill does not allow. Tell the user
  you can give them a static snapshot instead.
- **Slide decks.** Out of scope for v1 — recommend a dedicated tool.
- **PDF.** You produce HTML, not PDF. The print CSS is tuned so the user
  gets a clean PDF by hitting `Print → Save as PDF` in their browser. If the
  user *really* wants a pre-rendered PDF, say so — a different skill will
  handle that.

## Absolute rules

The skill scripts enforce every rule here. Violations return non-zero exit
codes, print the error to stderr, and produce no file. You then fix the
**JSON input** and retry.

1. **Never hand-write HTML.** Always go through `build_report.py` with a
   JSON spec. The JSON is the only supported interface.
2. **Never edit `templates/base.html`.** If the template produces something
   ugly, file it as feedback — do not patch in place.
3. **No `<script>`.** No JavaScript under any circumstances.
4. **No external resources.** No CDN fonts, no CDN CSS, no external images,
   no preconnect hints, no `<link>` to anything.
5. **Only `https://` URLs.** Plus `mailto:`, `#anchor`, or `/relative`. No
   `http://`, no `javascript:`, no `data:` in anchors.
6. **Images only as base64 data URIs.** `data:image/(png|jpeg|gif|webp|svg+xml);base64,...`
   Pre-render charts to PNG if you need graphics.
7. **No `style=` attributes.** The design system lives in the template.
   Trust it.
8. **No `on*=` event handlers.** Ever.
9. **Hard size cap: 8 MiB** (self-imposed; paperclip server limit is 10 MiB).
   If the report is too big, drop or downsample figures.

## Workflow — end to end

Run this from inside any container that has Python 3 (e.g., the paperclip
container). All paperclip env vars are auto-injected during agent runs.

```bash
# 1. Compose the report spec as JSON
cat > /tmp/report.json <<'JSON'
{
  "title": "Q1 2026 Infrastructure Review",
  "subtitle": "Reliability and cost posture",
  "lang": "en",
  "author": "Infra Team",
  "date": "2026-04-10",
  "executive_summary": {
    "text": "Latency down 24%, storage cost down $4.2k/mo, three incidents closed."
  },
  "sections": [
    { "type": "heading", "level": 2, "text": "Overview", "anchor": true },
    { "type": "text", "text": "Quarter started with a regional failover drill..." },
    { "type": "heading", "level": 2, "text": "Metrics", "anchor": true },
    {
      "type": "table",
      "caption": "Regional latency, ms",
      "head": [["Region", "p50", "p99"]],
      "rows": [
        ["us-east", "30", "142"],
        ["eu-west", "42", "188"]
      ]
    },
    {
      "type": "callout",
      "variant": "warn",
      "title": "Heads up",
      "body": "Backup window overlaps peak traffic in ap-south."
    }
  ],
  "references": [
    { "label": "PostgreSQL 16 release notes", "url": "https://www.postgresql.org/docs/16/release-16.html" }
  ]
}
JSON

# 2. Build + validate (one step)
python3 /app/skills/html-report/scripts/build_report.py \
  --input /tmp/report.json \
  --out   /tmp/report.html
# exit 0  → /tmp/report.html ready
# exit 1  → IO / JSON parse error — read stderr
# exit 2  → structural / validator error — read stderr, fix JSON, retry
# exit 3  → output > 8 MiB — shrink images

# 3. Upload to the current issue as an attachment
ATTACH_JSON=$(curl -fsS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -F "file=@/tmp/report.html;type=text/html" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/attachments")

ATTACH_PATH=$(printf '%s' "$ATTACH_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin)["contentPath"])')

# 4. Post a comment with the download link
curl -fsS -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -H "Content-Type: application/json" \
  -d "{\"body\":\"HTML report ready — [скачать]($ATTACH_PATH)\"}" \
  "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments"
```

Key facts for the agent reading this:

- `$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`, `$PAPERCLIP_COMPANY_ID`,
  `$PAPERCLIP_RUN_ID`, `$PAPERCLIP_TASK_ID` are auto-injected during
  heartbeat runs. Never hard-code them.
- The attachments endpoint returns an `IssueAttachment` object that
  **already includes `contentPath`** (e.g. `/api/attachments/<id>/content`).
  Use it directly — do not construct the URL by hand.
- When the user clicks the link in the paperclip UI, the browser downloads
  the file and opens it in a new tab as a standalone document. This is a
  feature, not a limitation — the report is isolated from the paperclip UI
  and can be saved, printed, forwarded.

## Block types (quick reference)

| `type`       | What it is                                     |
|--------------|------------------------------------------------|
| `heading`    | `<h2>`–`<h6>`, optionally anchored for the TOC |
| `text`       | Paragraph (plain string or inline spans)       |
| `list`       | `<ul>` or `<ol>`                               |
| `table`      | Data table with optional caption               |
| `figure`     | Image (base64 data URI only) + caption         |
| `callout`    | Info / good / warn / bad aside                 |
| `code_block` | `<pre><code>`                                  |
| `details`    | Native collapsible section                     |
| `divider`    | `<hr>`                                         |

Full field-by-field spec in `references/input-schema.md`.

## Troubleshooting — top 5 errors

If the builder exits non-zero, the first line of stderr starts with an
error code. The fixes below cover most cases. Full catalog in
`references/troubleshooting.md`.

- **`E303 href '...' must be https://, mailto:, #fragment or /relative`**
  You have an `http://` link or `javascript:` in a span's `href`. Rewrite
  it as `https://` or drop it.
- **`E001 string contains reserved slot token '@@PAPERCLIP_SLOT:'`**
  Your JSON contains the literal substring `@@PAPERCLIP_SLOT:` somewhere.
  Remove it — you almost certainly didn't mean to include it.
- **`E021 unknown block type 'X'`**
  You used a block `type` that doesn't exist. Allowed: `heading, text, list,
  table, figure, callout, code_block, details, divider`.
- **`E029 figure.image.data_uri must be data:image/...`**
  You linked an external image or used a wrong MIME type. Pre-render to PNG
  and embed as `data:image/png;base64,...`.
- **`E030 output is X MiB, exceeds 8 MiB self-cap`**
  The produced HTML is too big. Almost always because of a huge base64
  image — downsample it or drop it entirely.

## Bundled files

```
skills/html-report/
├── SKILL.md                     # this file
├── templates/base.html          # the locked template (do not edit)
├── scripts/
│   ├── build_report.py          # JSON → HTML + validate (main entry)
│   └── validate_html.py         # standalone validator
├── examples/
│   ├── minimal.json             # smallest happy path
│   ├── rich.json                # kitchen sink (ru + en, table, figure, code, details)
│   ├── bad-external-css.json    # should fail with E303
│   └── bad-script.json          # should fail with E303
└── references/
    ├── input-schema.md          # full JSON spec
    ├── content-whitelist.md     # allowed/forbidden tags and attributes
    ├── design-tokens.md         # CSS variable rationale
    └── troubleshooting.md       # full E-code catalog
```

## Smoke test (manual, not for agents to run in a live issue)

```bash
# inside the paperclip container or on any host with python3
python3 /app/skills/html-report/scripts/build_report.py \
  --input /app/skills/html-report/examples/rich.json \
  --out   /tmp/rich.html
# exit 0, 13 KB of HTML, cyrillic + english, tables, callouts, figure, details
```

## What this skill deliberately does NOT do

- No Chromium / headless browser rendering.
- No native PDF output — user presses `Print → Save as PDF`.
- No JavaScript-powered charts (Chart.js, D3, Plotly, Mermaid). Pre-render
  to PNG instead.
- No inline SVG. Use `<img src="data:image/svg+xml;base64,...">` via the
  `figure` block.
- No theme overrides from JSON — the palette is locked. If you need a
  different look, file feedback.
- No custom templates. Only `templates/base.html`.
- No upload from inside `build_report.py` — the script never touches your
  `$PAPERCLIP_API_KEY`. Upload is a separate `curl` step, shown above.
