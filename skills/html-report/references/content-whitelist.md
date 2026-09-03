# html-report content whitelist

Exhaustive list of what is allowed and what is forbidden in a rendered
html-report document. The validator (`scripts/validate_html.py`) enforces
every rule here on the final HTML; the builder (`scripts/build_report.py`)
enforces most of them earlier, on the JSON input.

## Allowed tags

### Document shell (emitted by the template, not by user content)

`html, head, title, meta, style, body`

### Landmarks / structural

`header, footer, main, nav, section, article, aside, div, span`

### Text flow

`h1, h2, h3, h4, h5, h6, p, ul, ol, li, strong, em, code, pre, blockquote, a, hr, br`

### Tables

`table, thead, tbody, tfoot, tr, th, td, caption`

### Media / semantic

`figure, figcaption, img`

### Native interactivity (no JavaScript)

`details, summary`

## Allowed attributes

| Tag | Attributes |
|-----|------------|
| `html` | `lang` |
| `meta` | `charset`, `name`, `content` — **not** `http-equiv` |
| `a` | `href` (scheme restricted, see below), `title`, `rel` |
| `img` | `src` (data URI only), `alt`, `width`, `height` |
| `table`, `th`, `td` | `colspan`, `rowspan`, `scope` |
| any | `id`, `class` |

## Forbidden tags — validator will reject

- `script` — **unconditionally**, including self-closing `<script/>`
- `iframe`, `object`, `embed`, `frame`, `frameset`, `applet` — no sandboxing surface
- `form`, `input`, `textarea`, `select` — no interactive forms
- `button` with `type="submit"` — no form submission
- `link` — the template emits none and none are allowed in content (external resources banned)
- `base` — could redirect relative URLs
- `svg`, `math` — inline vector graphics are not allowed in v1 (use `<img src="data:image/svg+xml;base64,...">` instead)

## Forbidden attributes — validator will reject

- **Any attribute named `on*`** — `onclick`, `onerror`, `onload`, `onmouseover`, etc.
- **`style`** — no inline styles; the design system in `templates/base.html` is the only source of truth
- `http-equiv="refresh"` on `<meta>` — no redirects

## URL scheme rules

### `<a href>`

Allowed:

- `https://...` — external links, must be TLS
- `mailto:...` — email
- `#anchor` — same-document anchor (TOC entries)
- `/path` or `./path` — relative, non-absolute

Forbidden:

- `http://...` — plain HTTP not allowed (mixed-content risk, MITM)
- `javascript:...` — XSS
- `data:...` — only allowed in `<img src>`, not in `<a href>`
- `ftp://`, `file://`, `gopher://`, etc.

### `<img src>`

Only `data:image/(png|jpe?g|gif|webp|svg+xml);base64,<base64 payload>` is
allowed. External `https://` images are **not** allowed because:

1. They break on locked-down corporate networks.
2. They leak reader-browser IPs to third parties.
3. The report is supposed to be a single-file archival artifact.

For charts/graphs, pre-render them to PNG in the agent's environment and
embed the base64.

### `<link href>`

The validator rejects any `<link>` whose `href` is not a `data:` URI or `#`
fragment. In practice, no `<link>` should appear in a produced report — the
template has none and the block model never emits one.

## Structural rules enforced by the validator

- Every opening tag must close, nested correctly (`E100`, `E101`, `E102`).
- `<p>` may not contain `<p>` (`E103`).
- Block-level elements (including `<div>`, `<p>`, `<h1>`–`<h6>`, `<table>`,
  `<ul>`, `<ol>`, `<figure>`, `<pre>`, etc.) may not appear inside inline
  ancestors (`<span>`, `<a>`, `<strong>`, `<em>`, `<code>`) (`E104`).
- `<li>` must be inside `<ul>` or `<ol>` (`E105`).
- `<tr>`, `<td>`, `<th>` must be inside `<table>` (`E106`).
- Exactly one `<style>` tag is allowed, and only inside `<head>` (`E204`).
- `<!doctype html>`, `<html>`, `<head>`, `<body>` must all be present
  (`E501`).

## Data URI format for images

Regex: `^data:image/(png|jpe?g|gif|webp|svg+xml);base64,[A-Za-z0-9+/=\s]+$`

- Whitespace inside the base64 payload is allowed (fine for wrapping).
- Types other than PNG/JPEG/GIF/WebP/SVG are rejected.
- **Do not** use `data:image/x-icon` or `data:image/avif` — not on the list.

## Summary: the five rules that catch 90% of agent mistakes

1. **No `http://`** — always `https://`, or relative, or `mailto:`.
2. **No external resources** — no CDN fonts, no CDN CSS, no external images.
3. **No scripts** — ever.
4. **No `style=` attributes** — trust the template, use block `type`s instead.
5. **Images as base64 data URIs only** — pre-render if needed.
