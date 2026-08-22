# html-report input JSON schema

This is the full specification of the JSON you pass to `build_report.py`.
It is the **only** interface for authoring reports — never write HTML by hand,
never edit `templates/base.html`.

## Top-level object

```jsonc
{
  "title":              "string, required",
  "subtitle":           "string, optional",
  "lang":               "string, optional — ISO 639-1 (e.g. 'en', 'ru', 'en-US'), default 'en'",
  "author":             "string, optional — plain text, rendered in footer + eyebrow",
  "date":               "string, optional — ISO date 'YYYY-MM-DD', rendered alongside author",
  "issue_ref":          "string, optional — e.g. 'INF-318', rendered in footer",
  "executive_summary":  "string | object, optional — see below",
  "sections":           "array, required — list of block objects (may be empty)",
  "references":         "array, optional — list of reference objects",
  "metadata":           "object, optional — flat string→string map, rendered in footer"
}
```

Unknown top-level keys → warning on stderr, not a hard error.

## `lang`

Must match the regex `^[a-z]{2}(-[A-Z]{2})?$`. Examples: `en`, `ru`, `en-US`,
`ru-RU`. Sets `<html lang="...">`. Does NOT affect fonts — the system font
stack covers Latin and Cyrillic.

## `executive_summary`

Three accepted shapes:

```jsonc
// 1. Plain string — wrapped in <p>
"executive_summary": "Three sentences that a busy CTO reads in 30s."

// 2. Object with text
"executive_summary": { "text": "Three sentences..." }

// 3. Object with spans (for inline emphasis)
"executive_summary": {
  "spans": [
    { "kind": "text",   "text": "Latency dropped to " },
    { "kind": "strong", "text": "142ms" },
    { "kind": "text",   "text": "." }
  ]
}

// 4. Object with blocks (for multi-paragraph / mixed content)
"executive_summary": {
  "blocks": [
    { "type": "text", "text": "First paragraph..." },
    { "type": "list", "style": "ul", "items": ["a", "b", "c"] }
  ]
}
```

## `sections` — list of blocks

A section is an array of block objects. Each block has a mandatory `type`.
Allowed types:

| `type`       | Purpose |
|--------------|---------|
| `heading`    | `<h2>`–`<h6>`, optionally anchored for TOC |
| `text`       | A paragraph (plain or with inline spans) |
| `list`       | `<ul>` or `<ol>` |
| `table`      | Data table with optional caption |
| `figure`     | `<img>` (data URI only) + caption |
| `callout`    | Info/good/warn/bad aside |
| `code_block` | Preformatted code |
| `details`    | Collapsible section |
| `divider`    | Horizontal rule |

### Block: `heading`

```jsonc
{
  "type": "heading",
  "level": 2,              // int, 2..6. h1 is reserved for the report title.
  "text":  "Section name",
  "anchor": true,          // optional; if true, include in TOC
  "id": "custom-id"        // optional; defaults to slug of text if anchor=true
}
```

If `anchor` is `true`, the heading also lands in the table of contents at the
top of the report. IDs are slugified (`text.lower()` with non-word chars
replaced by `-`) with a monotonic suffix on collisions.

### Block: `text`

```jsonc
// Plain
{ "type": "text", "text": "A normal paragraph." }

// With inline emphasis — use when you need strong/em/code/link inline
{
  "type": "text",
  "spans": [
    { "kind": "text",   "text": "Hit " },
    { "kind": "code",   "text": "/health" },
    { "kind": "text",   "text": " — see the " },
    { "kind": "link",   "text": "runbook", "href": "https://example.com" }
  ]
}
```

#### Span kinds

| `kind`  | Rendered | Required fields |
|---------|----------|-----------------|
| `text`  | plain text, escaped | `text` |
| `strong`| `<strong>` | `text` |
| `em`    | `<em>` | `text` |
| `code`  | `<code>` | `text` |
| `link`  | `<a href>` | `text`, `href` (must be https:// / mailto: / # / /) |

### Block: `list`

```jsonc
{
  "type": "list",
  "style": "ul",           // or "ol"
  "items": [
    "A plain string",
    [
      { "kind": "text",   "text": "Or a " },
      { "kind": "strong", "text": "spans array" },
      { "kind": "text",   "text": " for inline emphasis." }
    ]
  ]
}
```

### Block: `table`

```jsonc
{
  "type": "table",
  "caption": "Optional caption above the table",
  "head": [["Column A", "Column B", "Column C"]],
  "rows": [
    ["cell 1a", "cell 1b", "cell 1c"],
    ["cell 2a", "cell 2b", "cell 2c"]
  ]
}
```

Cells may be plain strings or spans arrays (same shape as inline spans above).
`head` is a `list[list]` so you can have multi-row headers if needed.

### Block: `figure`

```jsonc
{
  "type": "figure",
  "image": {
    "data_uri": "data:image/png;base64,iVBORw0KGgo...",
    "alt":   "Description for screen readers and print",
    "width": 720           // optional, int pixels, 1..4096
  },
  "caption": "Optional caption below the figure"
}
```

**Only data URIs are allowed.** The regex is
`^data:image/(png|jpe?g|gif|webp|svg+xml);base64,[A-Za-z0-9+/=]+$`.
For charts, pre-render them to PNG outside and embed as base64.

### Block: `callout`

```jsonc
{
  "type": "callout",
  "variant": "warn",       // "info" (default) | "good" | "warn" | "bad"
  "title": "Heads up",     // optional
  "body": "A plain string OR a block / list of blocks (like sections)."
}
```

`body` is recursive — you can put tables, lists, whatever inside.

### Block: `code_block`

```jsonc
{
  "type": "code_block",
  "language": "bash",      // optional; [a-z0-9+-]{1,20}, used only as a class hint
  "code": "docker compose up -d\ncurl -fsS http://localhost:3100/health"
}
```

No syntax highlighting is applied (no JS). The `language` is just a class name
for potential future use or for user-side print styling.

### Block: `details`

```jsonc
{
  "type": "details",
  "summary": "Click to expand",
  "body": [
    { "type": "text", "text": "Hidden content, rendered only when expanded." },
    { "type": "table", "head": [["k", "v"]], "rows": [["x", "1"]] }
  ]
}
```

Uses the native HTML `<details>/<summary>` — no JavaScript required. When
printed, the `@media print` rules in the template force all `details` content
visible regardless of state.

### Block: `divider`

```jsonc
{ "type": "divider" }
```

Renders as `<hr>`.

## `references`

```jsonc
"references": [
  {
    "label": "PostgreSQL 16 release notes",
    "url":   "https://www.postgresql.org/docs/16/release-16.html"
  },
  {
    "label": "Internal runbook",
    "text":  "ops/runbooks/regional-failover.md"
  }
]
```

- `label` — required, plain text.
- `url` — optional; must pass the same href scheme check as links.
- `text` — optional; rendered muted next to the label, e.g. for non-URL sources.

References are rendered as a numbered list at the bottom of the report, inside
`<section class="references">`.

## `metadata`

Flat string→string map. Rendered in the footer as `<p><strong>key:</strong> value</p>`
pairs. Use for things like `run_id`, `report_version`, `agent_id`, etc.

## Exit codes from `build_report.py`

| Code | Meaning |
|------|---------|
| `0`  | Success, HTML on stdout or at `--out` |
| `1`  | CLI or IO error, or JSON parse error |
| `2`  | Structural validation error (bad block, bad span, bad href, slot collision, or validator rejected produced HTML) |
| `3`  | Produced HTML is larger than 8 MiB (paperclip hard limit is 10 MiB) |

## Error codes summary

Full catalog in `references/troubleshooting.md`. Most common ones:

- `E001` — JSON contains the reserved substring `@@PAPERCLIP_SLOT:`
- `E021` — unknown block `type`
- `E030` — output too large
- `E200`/`E201` — external resource / script leaked into produced HTML
- `E303` — bad href scheme (must be https, mailto, #, /)
- `E400` — tag outside whitelist
