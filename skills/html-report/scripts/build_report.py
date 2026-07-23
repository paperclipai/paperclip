#!/usr/bin/env python3
"""
build_report.py — JSON → self-contained HTML report (html-report skill).

Usage:

    python3 build_report.py --input report.json --out report.html
    python3 build_report.py < report.json > report.html

Exit codes:
    0 — success, HTML written
    1 — CLI / IO / JSON-parse error
    2 — structural validation error (bad input or bad produced HTML)
    3 — produced HTML exceeds the 8 MiB self-cap

No third-party dependencies. Python standard library only.
The produced HTML is fully self-contained: inline CSS, no scripts,
no external resources, images only as data: URIs.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from pathlib import Path

# Allow `from validate_html import validate` when running as a script.
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import validate_html  # noqa: E402


SLOT_TOKEN = "@@PAPERCLIP_SLOT:"
SIZE_CAP_BYTES = 8 * 1024 * 1024  # 8 MiB — gives headroom under paperclip's 10 MiB

DEFAULT_TEMPLATE = _SCRIPT_DIR.parent / "templates" / "base.html"

_SLUG_RE = re.compile(r"[^\w\u00c0-\uffff]+", re.UNICODE)
_LANG_RE = re.compile(r"^[a-z]{2}(-[A-Z]{2})?$")
_HREF_SAFE_RE = re.compile(r"^(https:|mailto:|#|/)")
_DATA_IMAGE_RE = re.compile(
    r"^data:image/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$"
)
_LANGUAGE_RE = re.compile(r"^[a-z0-9+\-]{1,20}$")
_CALLOUT_VARIANTS = {"info", "good", "warn", "bad"}
_LIST_STYLES = {"ul", "ol"}
_SPAN_KINDS = {"text", "strong", "em", "code", "link"}

_ALL_BLOCK_TYPES = {
    "heading", "text", "list", "table", "figure",
    "callout", "code_block", "details", "divider",
}


# ---------------------------------------------------------------------------
# Input errors
# ---------------------------------------------------------------------------


class InputError(Exception):
    """Structural problem in the JSON input."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.msg = message


def _err(code: str, message: str) -> InputError:
    return InputError(code, message)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _esc(value: str) -> str:
    """HTML-escape a string. Everything user-provided goes through this."""
    return html.escape(value if value is not None else "", quote=True)


def _require_str(obj: dict, key: str, ctx: str) -> str:
    val = obj.get(key)
    if not isinstance(val, str) or not val:
        raise _err("E010", f"{ctx}: field {key!r} must be a non-empty string")
    return val


def _optional_str(obj: dict, key: str, ctx: str) -> str | None:
    val = obj.get(key)
    if val is None:
        return None
    if not isinstance(val, str):
        raise _err("E011", f"{ctx}: field {key!r} must be a string or null")
    return val


def _scan_for_slot_tokens(value, path: str = "$") -> None:
    """Recursively refuse any string that contains the slot token."""
    if isinstance(value, str):
        if SLOT_TOKEN in value:
            raise _err(
                "E001",
                f"{path}: string contains reserved slot token "
                f"{SLOT_TOKEN!r} — refusing to substitute",
            )
    elif isinstance(value, dict):
        for k, v in value.items():
            _scan_for_slot_tokens(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _scan_for_slot_tokens(v, f"{path}[{i}]")


def _check_href(href: str, ctx: str) -> str:
    stripped = href.strip()
    if not _HREF_SAFE_RE.match(stripped):
        raise _err(
            "E303",
            f"{ctx}: href {stripped!r} must be https://, mailto:, "
            f"#fragment or /relative",
        )
    return stripped


# ---------------------------------------------------------------------------
# Inline spans → HTML
# ---------------------------------------------------------------------------


def _render_spans(spans: object, ctx: str) -> str:
    if not isinstance(spans, list):
        raise _err("E012", f"{ctx}: spans must be a list")
    parts: list[str] = []
    for i, span in enumerate(spans):
        span_ctx = f"{ctx}[{i}]"
        if isinstance(span, str):
            parts.append(_esc(span))
            continue
        if not isinstance(span, dict):
            raise _err("E013", f"{span_ctx}: span must be string or object")
        kind = span.get("kind")
        if kind not in _SPAN_KINDS:
            raise _err("E014", f"{span_ctx}: span.kind must be one of {_SPAN_KINDS}")
        text = span.get("text", "")
        if not isinstance(text, str):
            raise _err("E015", f"{span_ctx}: span.text must be a string")
        if kind == "text":
            parts.append(_esc(text))
        elif kind == "strong":
            parts.append(f"<strong>{_esc(text)}</strong>")
        elif kind == "em":
            parts.append(f"<em>{_esc(text)}</em>")
        elif kind == "code":
            parts.append(f"<code>{_esc(text)}</code>")
        elif kind == "link":
            href = span.get("href")
            if not isinstance(href, str):
                raise _err("E016", f"{span_ctx}: link span missing href")
            safe = _check_href(href, span_ctx)
            parts.append(f'<a href="{_esc(safe)}">{_esc(text)}</a>')
    return "".join(parts)


def _render_inline(content, ctx: str) -> str:
    """Accept either a plain string or a spans list → inline HTML."""
    if isinstance(content, str):
        return _esc(content)
    if isinstance(content, list):
        return _render_spans(content, ctx)
    raise _err("E017", f"{ctx}: expected string or spans list")


# ---------------------------------------------------------------------------
# Slug / TOC
# ---------------------------------------------------------------------------


class _SlugGenerator:
    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    def make(self, text: str) -> str:
        base = _SLUG_RE.sub("-", text.lower()).strip("-") or "section"
        n = self._seen.get(base, 0) + 1
        self._seen[base] = n
        return base if n == 1 else f"{base}-{n}"


# ---------------------------------------------------------------------------
# Block rendering
# ---------------------------------------------------------------------------


def _render_block(block, slugger: _SlugGenerator, toc: list[tuple[str, str]],
                  ctx: str) -> str:
    if not isinstance(block, dict):
        raise _err("E020", f"{ctx}: block must be an object")
    btype = block.get("type")
    if btype not in _ALL_BLOCK_TYPES:
        raise _err(
            "E021",
            f"{ctx}: unknown block type {btype!r}; allowed: "
            f"{sorted(_ALL_BLOCK_TYPES)}",
        )

    if btype == "heading":
        level = block.get("level", 2)
        if not isinstance(level, int) or not 2 <= level <= 6:
            raise _err("E022", f"{ctx}: heading.level must be an int 2..6")
        text = _require_str(block, "text", ctx)
        anchor = bool(block.get("anchor", False))
        hid = block.get("id")
        if anchor:
            if hid is None:
                hid = slugger.make(text)
            elif not isinstance(hid, str):
                raise _err("E023", f"{ctx}: heading.id must be a string")
            toc.append((hid, text))
            return f'<h{level} id="{_esc(hid)}">{_esc(text)}</h{level}>'
        return f"<h{level}>{_esc(text)}</h{level}>"

    if btype == "text":
        if "spans" in block:
            inner = _render_spans(block["spans"], f"{ctx}.spans")
        else:
            inner = _esc(_require_str(block, "text", ctx))
        return f"<p>{inner}</p>"

    if btype == "list":
        style = block.get("style", "ul")
        if style not in _LIST_STYLES:
            raise _err("E024", f"{ctx}: list.style must be 'ul' or 'ol'")
        items = block.get("items")
        if not isinstance(items, list) or not items:
            raise _err("E025", f"{ctx}: list.items must be a non-empty list")
        lis: list[str] = []
        for i, item in enumerate(items):
            inner = _render_inline(item, f"{ctx}.items[{i}]")
            lis.append(f"<li>{inner}</li>")
        return f"<{style}>{''.join(lis)}</{style}>"

    if btype == "table":
        head = block.get("head") or []
        rows = block.get("rows") or []
        if not isinstance(head, list) or not all(isinstance(r, list) for r in head):
            raise _err("E026", f"{ctx}: table.head must be list[list]")
        if not isinstance(rows, list) or not all(isinstance(r, list) for r in rows):
            raise _err("E027", f"{ctx}: table.rows must be list[list]")
        parts: list[str] = ["<table>"]
        caption = _optional_str(block, "caption", ctx)
        if caption:
            parts.append(f"<caption>{_esc(caption)}</caption>")
        if head:
            parts.append("<thead>")
            for hrow in head:
                parts.append("<tr>")
                for cell in hrow:
                    parts.append(f"<th>{_render_inline(cell, ctx)}</th>")
                parts.append("</tr>")
            parts.append("</thead>")
        parts.append("<tbody>")
        for row in rows:
            parts.append("<tr>")
            for cell in row:
                parts.append(f"<td>{_render_inline(cell, ctx)}</td>")
            parts.append("</tr>")
        parts.append("</tbody></table>")
        return "".join(parts)

    if btype == "figure":
        image = block.get("image")
        if not isinstance(image, dict):
            raise _err("E028", f"{ctx}: figure.image must be an object")
        data_uri = image.get("data_uri", "")
        if not isinstance(data_uri, str) or not _DATA_IMAGE_RE.match(data_uri.strip()):
            raise _err(
                "E029",
                f"{ctx}: figure.image.data_uri must be "
                f"data:image/(png|jpe?g|gif|webp|svg+xml);base64,...",
            )
        alt = image.get("alt", "")
        if not isinstance(alt, str):
            raise _err("E031", f"{ctx}: figure.image.alt must be a string")
        width = image.get("width")
        width_attr = ""
        if width is not None:
            if not isinstance(width, int) or width <= 0 or width > 4096:
                raise _err("E032", f"{ctx}: figure.image.width must be int 1..4096")
            width_attr = f' width="{width}"'
        caption = _optional_str(block, "caption", ctx)
        figcap = f"<figcaption>{_esc(caption)}</figcaption>" if caption else ""
        return (
            f'<figure><img src="{_esc(data_uri.strip())}" '
            f'alt="{_esc(alt)}"{width_attr}>{figcap}</figure>'
        )

    if btype == "callout":
        variant = block.get("variant", "info")
        if variant not in _CALLOUT_VARIANTS:
            raise _err("E033", f"{ctx}: callout.variant must be one of {_CALLOUT_VARIANTS}")
        title = _optional_str(block, "title", ctx)
        body = block.get("body")
        body_html = _render_body(body, slugger, toc, f"{ctx}.body")
        title_html = (
            f'<p class="callout-title">{_esc(title)}</p>' if title else ""
        )
        return (
            f'<aside class="callout callout--{variant}">'
            f"{title_html}{body_html}</aside>"
        )

    if btype == "code_block":
        code_text = block.get("code", "")
        if not isinstance(code_text, str):
            raise _err("E034", f"{ctx}: code_block.code must be a string")
        language = block.get("language")
        lang_attr = ""
        if language is not None:
            if not isinstance(language, str) or not _LANGUAGE_RE.match(language):
                raise _err(
                    "E035",
                    f"{ctx}: code_block.language must match {_LANGUAGE_RE.pattern}",
                )
            lang_attr = f' class="lang-{language}"'
        return f"<pre><code{lang_attr}>{_esc(code_text)}</code></pre>"

    if btype == "details":
        summary = _require_str(block, "summary", ctx)
        body = block.get("body")
        body_html = _render_body(body, slugger, toc, f"{ctx}.body")
        return (
            f"<details><summary>{_esc(summary)}</summary>"
            f"{body_html}</details>"
        )

    if btype == "divider":
        return "<hr>"

    # unreachable — caught above
    raise _err("E021", f"{ctx}: unknown block type {btype!r}")


def _render_body(body, slugger: _SlugGenerator,
                 toc: list[tuple[str, str]], ctx: str) -> str:
    """Body may be a single block, a list of blocks, or a plain string."""
    if body is None:
        return ""
    if isinstance(body, str):
        return f"<p>{_esc(body)}</p>"
    if isinstance(body, dict):
        return _render_block(body, slugger, toc, ctx)
    if isinstance(body, list):
        return "".join(
            _render_block(b, slugger, toc, f"{ctx}[{i}]")
            for i, b in enumerate(body)
        )
    raise _err("E036", f"{ctx}: body must be string, object, or list")


# ---------------------------------------------------------------------------
# Top-level rendering
# ---------------------------------------------------------------------------


def _render_executive_summary(summary, slugger, toc, ctx: str) -> str:
    if summary is None:
        return ""
    if isinstance(summary, str):
        return f"<p>{_esc(summary)}</p>"
    if isinstance(summary, dict):
        if "text" in summary:
            return f"<p>{_esc(str(summary['text']))}</p>"
        if "spans" in summary:
            return f"<p>{_render_spans(summary['spans'], f'{ctx}.spans')}</p>"
        if "blocks" in summary:
            return _render_body(summary["blocks"], slugger, toc, f"{ctx}.blocks")
    raise _err(
        "E040",
        f"{ctx}: executive_summary must be string or object with "
        f"'text' | 'spans' | 'blocks'",
    )


def _render_references(refs, ctx: str) -> str:
    if not refs:
        return ""
    if not isinstance(refs, list):
        raise _err("E050", f"{ctx}: references must be a list")
    items: list[str] = []
    for i, ref in enumerate(refs):
        ref_ctx = f"{ctx}[{i}]"
        if not isinstance(ref, dict):
            raise _err("E051", f"{ref_ctx}: reference must be an object")
        label = _require_str(ref, "label", ref_ctx)
        url = _optional_str(ref, "url", ref_ctx)
        text = _optional_str(ref, "text", ref_ctx)
        if url:
            safe = _check_href(url, ref_ctx)
            line = f'<a href="{_esc(safe)}">{_esc(label)}</a>'
        else:
            line = f"<strong>{_esc(label)}</strong>"
        if text:
            line += f' <span class="ref-text">— {_esc(text)}</span>'
        items.append(f"<li>{line}</li>")
    return f'<h2 id="references">References</h2><ol class="refs">{"".join(items)}</ol>'


def _render_toc(toc: list[tuple[str, str]]) -> str:
    if not toc:
        return ""
    items = "".join(
        f'<li><a href="#{_esc(hid)}">{_esc(text)}</a></li>'
        for hid, text in toc
    )
    return f'<ol class="toc-list">{items}</ol>'


def _render_footer(data: dict, ctx: str) -> str:
    parts: list[str] = []
    author = _optional_str(data, "author", ctx)
    date = _optional_str(data, "date", ctx)
    issue_ref = _optional_str(data, "issue_ref", ctx)
    bits: list[str] = []
    if author:
        bits.append(_esc(author))
    if date:
        bits.append(_esc(date))
    if issue_ref:
        bits.append(f"Issue {_esc(issue_ref)}")
    if bits:
        parts.append(f"<p>{' · '.join(bits)}</p>")
    metadata = data.get("metadata") or {}
    if isinstance(metadata, dict) and metadata:
        for k, v in metadata.items():
            if not isinstance(k, str):
                continue
            parts.append(f"<p><strong>{_esc(k)}:</strong> {_esc(str(v))}</p>")
    parts.append("<p>Generated by paperclip/html-report</p>")
    return "".join(parts)


def _render_meta_line(data: dict) -> str:
    """Small eyebrow line above the h1."""
    bits: list[str] = []
    author = data.get("author")
    date = data.get("date")
    if isinstance(author, str) and author:
        bits.append(_esc(author))
    if isinstance(date, str) and date:
        bits.append(_esc(date))
    return " · ".join(bits) if bits else "Report"


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def build(data: object, template_text: str) -> str:
    """Full pipeline: validate → render → substitute → validate HTML."""
    if not isinstance(data, dict):
        raise _err("E002", "top-level JSON must be an object")
    _scan_for_slot_tokens(data)

    # Required
    title = _require_str(data, "title", "$")
    sections = data.get("sections")
    if not isinstance(sections, list):
        raise _err("E003", "$.sections must be a list")

    # Optional
    subtitle = _optional_str(data, "subtitle", "$") or ""
    lang = _optional_str(data, "lang", "$") or "en"
    if not _LANG_RE.match(lang):
        raise _err("E004", f"$.lang {lang!r} must match [a-z]{{2}}(-[A-Z]{{2}})?")

    slugger = _SlugGenerator()
    toc: list[tuple[str, str]] = []

    body_parts: list[str] = []
    for i, block in enumerate(sections):
        body_parts.append(_render_block(block, slugger, toc, f"$.sections[{i}]"))
    body_html = "".join(body_parts)

    summary_html = _render_executive_summary(
        data.get("executive_summary"), slugger, toc, "$.executive_summary"
    )
    refs_html = _render_references(data.get("references"), "$.references")
    toc_html = _render_toc(toc)
    footer_html = _render_footer(data, "$")
    meta_line = _render_meta_line(data)

    # Substitute
    slots = {
        "lang": _esc(lang),
        "title": _esc(title),
        "subtitle": _esc(subtitle),
        "meta": meta_line,
        "toc": toc_html,
        "executive_summary": summary_html,
        "body": body_html,
        "references": refs_html,
        "footer": footer_html,
    }
    result = template_text
    for slot_name, slot_value in slots.items():
        token = f"{SLOT_TOKEN}{slot_name}@@"
        if token not in result:
            raise _err("E005", f"template missing slot {token}")
        result = result.replace(token, slot_value)

    # Sanity: no leftover slot tokens
    if SLOT_TOKEN in result:
        leftover = result.split(SLOT_TOKEN, 1)[1].split("@@", 1)[0]
        raise _err("E006", f"template has unknown leftover slot {leftover!r}")

    # Final policy validation on the rendered HTML.
    errors = validate_html.validate(result)
    if errors:
        rendered = "\n".join(
            f"{e.code}:{e.line}:{e.col}: {e.message}" for e in errors
        )
        raise _err("E007", "validator rejected produced HTML:\n" + rendered)

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_input(path: str | None) -> dict:
    try:
        if path:
            raw = Path(path).read_text(encoding="utf-8")
        else:
            raw = sys.stdin.read()
    except OSError as exc:
        raise _err("E008", f"cannot read input: {exc}") from exc
    if not raw.strip():
        raise _err("E009", "input is empty")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise _err("E009", f"invalid JSON: {exc.msg} at line {exc.lineno}") from exc


def _read_template(path: str | None) -> str:
    template_path = Path(path) if path else DEFAULT_TEMPLATE
    try:
        return template_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise _err("E008", f"cannot read template {template_path}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Build a self-contained HTML report from a JSON spec.",
    )
    ap.add_argument("--input", help="JSON input file (default: stdin)")
    ap.add_argument("--out", help="HTML output file (default: stdout)")
    ap.add_argument("--template", help=f"Template override (default: {DEFAULT_TEMPLATE})")
    ap.add_argument("--quiet", action="store_true", help="Suppress progress on stderr")
    args = ap.parse_args(argv)

    quiet = args.quiet

    def log(*items: object, **kwargs: object) -> None:
        if quiet:
            return
        print(*items, file=sys.stderr, **kwargs)  # type: ignore[arg-type]

    try:
        data = _read_input(args.input)
        template = _read_template(args.template)
    except InputError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        html_text = build(data, template)
    except InputError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    size = len(html_text.encode("utf-8"))
    if size > SIZE_CAP_BYTES:
        mib = size / (1024 * 1024)
        print(
            f"E030:0:0: output is {mib:.2f} MiB, exceeds 8 MiB self-cap "
            f"(paperclip hard limit is 10 MiB)",
            file=sys.stderr,
        )
        return 3

    log(f"html-report: rendered {size} bytes, validator clean")

    if args.out:
        Path(args.out).write_text(html_text, encoding="utf-8")
    else:
        sys.stdout.write(html_text)

    return 0


if __name__ == "__main__":
    sys.exit(main())
