# html-report troubleshooting

Catalog of error codes emitted by `build_report.py` and `validate_html.py`,
with symptoms and fixes. Each message has the shape:

```
CODE:LINE:COL: message
```

The `LINE`/`COL` are positions in the produced HTML when the validator
rejects rendered output; for input-schema errors the position is a JSON
path like `$.sections[3].body.items[0]`.

## Input / build errors (from `build_report.py`)

| Code | Symptom | Cause | Fix |
|------|---------|-------|-----|
| `E001` | `$.<path>: string contains reserved slot token '@@PAPERCLIP_SLOT:'` | Some string in the JSON contains the literal substring `@@PAPERCLIP_SLOT:`, which is the template slot marker | Remove the substring from your content — you almost certainly did not mean to include it |
| `E002` | `top-level JSON must be an object` | Top-level value is not a JSON object | Wrap your content in `{ }` |
| `E003` | `$.sections must be a list` | `sections` missing or not an array | Provide `"sections": [ ... ]` (may be empty) |
| `E004` | `$.lang <value> must match ...` | `lang` does not match `[a-z]{2}(-[A-Z]{2})?` | Use `"en"`, `"ru"`, `"en-US"`, etc. |
| `E005` | `template missing slot @@PAPERCLIP_SLOT:...@@` | Template was hand-edited and a slot was removed | Do not edit `templates/base.html` |
| `E006` | `template has unknown leftover slot` | Custom template introduced an unknown slot | Same as above — use the bundled template |
| `E007` | `validator rejected produced HTML: ...` | The rendered HTML did not pass the policy validator. The nested lines give the actual `E1xx–E5xx` codes | Read the nested errors and fix the offending block |
| `E008` | `cannot read input / template: ...` | Filesystem error | Check paths and permissions |
| `E009` | `invalid JSON: ...` | Malformed JSON (trailing comma, unquoted key, etc.) | Fix the JSON; `python3 -m json.tool < file.json` helps |
| `E010` / `E011` | `field X must be a string` | Required string missing or wrong type | Provide the field as a non-empty string |
| `E012`–`E017` | `spans ...` | Inline span list is malformed | Each span must be either a plain string or `{kind, text, [href]}` with a valid `kind` |
| `E020` / `E021` | `block must be an object / unknown block type` | Section block is not an object, or has an unknown `type` | Use one of: `heading, text, list, table, figure, callout, code_block, details, divider` |
| `E022` | `heading.level must be an int 2..6` | Bad heading level | Only `h2`–`h6` are available; `h1` is reserved for the report title |
| `E023` | `heading.id must be a string` | Non-string id | Remove the `id` to auto-slug, or provide a string |
| `E024` | `list.style must be 'ul' or 'ol'` | Bad list style | Use exactly `"ul"` or `"ol"` |
| `E025` | `list.items must be a non-empty list` | Empty list | Add at least one item, or drop the block |
| `E026` / `E027` | `table.head / table.rows must be list[list]` | Table structure wrong | Both must be arrays of arrays |
| `E028` | `figure.image must be an object` | Missing or wrong-type image | Provide `{data_uri, alt, [width]}` |
| `E029` | `figure.image.data_uri must be data:image/...` | URL is not a data URI, or wrong MIME type | Pre-render to PNG/JPEG/WebP and base64-encode |
| `E031` | `figure.image.alt must be a string` | Missing / wrong type | Always provide `alt` text, even an empty string is better than missing |
| `E032` | `figure.image.width must be int 1..4096` | Bad width | Integer pixels, 1..4096 |
| `E033` | `callout.variant must be one of ...` | Unknown variant | Use `info`, `good`, `warn`, or `bad` |
| `E034` | `code_block.code must be a string` | Missing code | Provide the code text |
| `E035` | `code_block.language must match ...` | Bad language string | Use lowercase letters, digits, `+`, `-`, max 20 chars (e.g. `bash`, `python`, `c++`) |
| `E036` | `body must be string, object, or list` | Callout/details body has wrong shape | Pass a single block, a list of blocks, or a plain string |
| `E040` | `executive_summary must be string or object with 'text' \| 'spans' \| 'blocks'` | Summary has wrong shape | Use one of the four allowed shapes |
| `E050` / `E051` | `references ...` | References list is malformed | Each entry must be `{label, [url], [text]}` |
| `E030` | `output is N MiB, exceeds 8 MiB self-cap` | Produced HTML > 8 MiB (usually giant base64 images) | Downsample or drop images; text is rarely the problem |
| `E303` | `href '<value>' must be https://, mailto:, #fragment or /relative` | Unsafe link scheme | Rewrite the URL — `http://` is not allowed (use `https://` or drop the link) |

## Rendered-HTML validation errors (from `validate_html.py`)

These are only reached if the builder successfully rendered the HTML but
the validator then noticed a policy violation. Almost all of these indicate
a bug in the builder or a hand-edited template — they should be
unreachable from pure JSON input. Report them.

### Well-formedness (E100s)

| Code | Symptom | Fix |
|------|---------|-----|
| `E100` | `<tag> opened but never closed` | Builder bug — report it |
| `E101` | `</x> does not match currently open <y>` | Builder bug — report it |
| `E102` | `</x> with no matching opening tag` | Builder bug — report it |
| `E103` | `<p> may not contain another <p>` | You put a `text` block inside another `text` block's spans, or a heading inside a paragraph. Split into siblings |
| `E104` | `<block> inside <inline> not allowed` | You nested a block-level element (table/list/etc.) inside an inline context. Split into siblings |
| `E105` | `<li> outside <ul>/<ol>` | Builder bug — report it |
| `E106` | `<tr>/<td>/<th> outside <table>` | Builder bug — report it |

### External resources (E200s)

| Code | Symptom | Fix |
|------|---------|-----|
| `E200` | `<link href=... > external resource forbidden` | Template was hand-edited with a CDN `<link>`. Revert the template |
| `E201` | `<script> is forbidden` | A `<script>` slipped into output. Usually means the template was tampered with, or the slot token was bypassed |
| `E202` | `<img src> must be data:image/...;base64,...` | Figure image URI is wrong. See `E029` |
| `E203` | `<iframe/object/embed/frame/frameset/applet> forbidden` | Template was tampered with |
| `E204` | `<style> outside <head>` or duplicated | Template has extra `<style>`. Revert the template |
| `E205` | `<base> is forbidden` | Template was tampered with |
| `E206` | `<meta http-equiv='refresh'>` | Template was tampered with |

### Event handlers & dangerous attributes (E300s)

| Code | Symptom | Fix |
|------|---------|-----|
| `E300` | `<tag> has event handler attribute 'onX'` | Some attribute starting with `on` slipped through. Builder bug — report it |
| `E301` | `<tag> has inline style attribute` | Someone put `style=` into a block. Use design tokens instead, never inline styles |
| `E302` | `<tag attr=...> uses javascript: URL` | A `javascript:` URL was found in an attribute. Should have been caught by `E303` first |
| `E303` | See input-errors table above | Fix the `href` |
| `E304` | `<form/input/textarea/select/button type='submit'> forbidden` | No forms allowed in reports |

### Whitelist & shell (E400s / E500s)

| Code | Symptom | Fix |
|------|---------|-----|
| `E400` | `<tag> not in allowed tag whitelist` | Tag outside the whitelist in `content-whitelist.md`. Switch to an allowed tag |
| `E500` | `input HTML is empty` | Builder bug — report it |
| `E501` | `missing <!doctype html> / <html> / <head> / <body>` | Template was hand-edited |

## The five problems that account for 90% of rejected reports

1. **`E303` bad href.** You typed `http://` instead of `https://`, or you
   put a URL with no scheme expecting it to resolve. Always use `https://`,
   `mailto:`, `#anchor`, or `/relative`.
2. **`E029` bad image data URI.** You embedded an image URL instead of a
   base64 data URI, or you used a MIME type other than PNG/JPEG/GIF/WebP/SVG.
3. **`E030` file too large.** You embedded a high-resolution figure without
   downsampling. Aim for PNGs under 500 KB before base64; base64 adds ~33%
   overhead.
4. **`E021` unknown block type.** You typed `paragraph` instead of `text`,
   `image` instead of `figure`, `note` instead of `callout`. See the list in
   `input-schema.md`.
5. **`E001` accidental slot token.** The literal substring `@@PAPERCLIP_SLOT:`
   is reserved. If you see this, remove that substring from your content.

## How to debug a rejected report

```bash
# 1. Save your JSON input
cat > /tmp/report.json <<'JSON'
{ "title": ... }
JSON

# 2. Run the builder and read stderr carefully
python3 /app/skills/html-report/scripts/build_report.py \
  --input /tmp/report.json --out /tmp/report.html 2>&1

# 3. If it got as far as producing HTML but validator rejected it,
#    run the standalone validator to get line/column numbers:
python3 /app/skills/html-report/scripts/validate_html.py /tmp/report.html

# 4. For input-schema errors, the message includes the JSON path like
#    $.sections[3].body.items[0] — navigate there in your JSON and fix.
```

## When to escalate

Report a bug (not user error) if you see any of:

- Any `E100`–`E106` while using structured blocks only (no hand-edited template).
- Any `E200`–`E206`, `E500`, or `E501`.
- `E030` with a report that has **no** images and is still > 8 MiB.
- `E400` from a tag that the block model should not emit.

These indicate either a builder bug or a tampered template.
