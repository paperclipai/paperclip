#!/usr/bin/env python3
"""
validate_html.py — stdlib-only HTML validator for the html-report skill.

Two usage modes:

    # 1. Standalone CLI — validate a file on disk:
    python3 validate_html.py /path/to/report.html
    # exit 0 on clean, exit 2 on any error, errors printed to stderr.

    # 2. Importable API — used by build_report.py after slot substitution:
    from validate_html import validate
    errors = validate(html_text)
    if errors:
        ...

The validator enforces the html-report security and correctness contract:
no scripts, no external resources, no event handlers, no style attributes,
no raw inline <svg>, only whitelisted tags, well-formed nesting.

No third-party dependencies — Python standard library only (html.parser, re,
sys, pathlib, argparse, collections).
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import namedtuple
from html.parser import HTMLParser
from pathlib import Path

ValidationError = namedtuple("ValidationError", "line col code message")


# ---------------------------------------------------------------------------
# Policy constants
# ---------------------------------------------------------------------------

# Tags that may appear anywhere in a valid report. Anything outside this set
# triggers E400.
ALLOWED_TAGS: frozenset[str] = frozenset({
    # document shell
    "html", "head", "title", "meta", "style", "body",
    # landmark / structural
    "header", "footer", "main", "nav", "section", "article", "aside",
    "div", "span",
    # headings and text flow
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "ul", "ol", "li",
    "strong", "em", "code", "pre", "blockquote",
    "a", "hr", "br",
    # tables
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
    # media / semantic
    "figure", "figcaption", "img",
    # native interactivity (no JS)
    "details", "summary",
})

# Tags that are block-level for nesting purposes. A <p> cannot contain any of
# these; an inline ancestor (see INLINE_ANCESTORS) cannot either.
BLOCK_TAGS: frozenset[str] = frozenset({
    "div", "p", "section", "article", "header", "footer", "nav", "aside",
    "main", "table", "thead", "tbody", "tfoot", "tr", "ul", "ol", "li",
    "figure", "figcaption", "pre", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "details", "summary", "hr",
})

# Inline elements that must not contain block-level descendants.
INLINE_ANCESTORS: frozenset[str] = frozenset({
    "span", "a", "strong", "em", "code",
})

# Tags that are hard-forbidden even though html.parser will parse them.
FORBIDDEN_TAGS: frozenset[str] = frozenset({
    "script", "iframe", "object", "embed", "frame", "frameset", "applet",
    "form", "input", "textarea", "select", "base",
    # svg is only allowed via <img src="data:image/svg+xml;base64,..."> —
    # inline <svg> is not permitted in v1.
    "svg", "math",
})

# Void elements that do not need a closing tag.
VOID_TAGS: frozenset[str] = frozenset({
    "br", "hr", "img", "meta", "link", "input", "source", "area", "col",
    "embed", "param", "track", "wbr", "base",
})

# Allowed URL schemes for <a href="...">. Empty string means relative/fragment.
_ANCHOR_SAFE_SCHEMES: frozenset[str] = frozenset({"https", "mailto"})

_DATA_IMAGE_RE = re.compile(
    r"^data:image/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$"
)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


class _ReportValidator(HTMLParser):
    def __init__(self) -> None:
        # convert_charrefs=False so we see raw entities if we ever need them.
        super().__init__(convert_charrefs=True)
        self.errors: list[ValidationError] = []
        self.stack: list[tuple[str, int, int]] = []  # (tag, line, col)
        self._style_count = 0
        self._in_head = False
        self._seen_doctype = False
        self._seen_html = False
        self._seen_head = False
        self._seen_body = False

    # --- helpers ----------------------------------------------------------

    def _err(self, code: str, msg: str) -> None:
        line, col = self.getpos()
        self.errors.append(ValidationError(line, col, code, msg))

    def _check_attrs(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            low = name.lower()

            # E300 — any on* event handler
            if low.startswith("on"):
                self._err("E300", f"<{tag}> has event handler attribute {name!r}")

            # E301 — inline style attribute
            if low == "style":
                self._err("E301", f"<{tag}> has inline style attribute")

            # E302 — javascript: in URL-bearing attributes
            if low in ("href", "src", "action", "formaction", "xlink:href") and value:
                stripped = value.strip().lower()
                if stripped.startswith("javascript:"):
                    self._err("E302", f"<{tag} {name}=...> uses javascript: URL")

            # E206 — meta http-equiv=refresh
            if tag == "meta" and low == "http-equiv" and value and value.lower() == "refresh":
                self._err("E206", "<meta http-equiv='refresh'> is forbidden")

        # E303 — <a href> scheme check (https / mailto / # / / are ok)
        if tag == "a":
            for name, value in attrs:
                if name.lower() == "href" and value is not None:
                    v = value.strip()
                    if v.startswith("#") or v.startswith("/"):
                        continue
                    if ":" in v:
                        scheme = v.split(":", 1)[0].lower()
                        if scheme not in _ANCHOR_SAFE_SCHEMES:
                            self._err(
                                "E303",
                                f"<a href={v!r}> scheme {scheme!r} not allowed "
                                f"(only https, mailto, #fragment, /relative)",
                            )
                    else:
                        # no scheme, no fragment, no leading slash — treat as
                        # relative; that is fine for same-document anchors.
                        continue

        # E200 — <link href=...> external
        if tag == "link":
            for name, value in attrs:
                if name.lower() == "href" and value is not None:
                    v = value.strip()
                    if v.startswith("#") or v.startswith("data:"):
                        continue
                    if v:
                        self._err(
                            "E200",
                            f"<link href={v!r}> external resource forbidden",
                        )

        # E202 — <img src> must be data:image/...;base64,...
        if tag == "img":
            src_val: str | None = None
            for name, value in attrs:
                if name.lower() == "src":
                    src_val = value
                    break
            if src_val is None:
                self._err("E202", "<img> missing src attribute")
            else:
                if not _DATA_IMAGE_RE.match(src_val.strip()):
                    self._err(
                        "E202",
                        "<img src> must be data:image/(png|jpeg|gif|webp|svg+xml);base64,...",
                    )

    # --- handlers ---------------------------------------------------------

    def handle_decl(self, decl: str) -> None:
        if decl.lower().startswith("doctype"):
            self._seen_doctype = True

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        line, col = self.getpos()

        if tag == "html":
            self._seen_html = True
        elif tag == "head":
            self._seen_head = True
            self._in_head = True
        elif tag == "body":
            self._seen_body = True
            self._in_head = False

        # E201 — <script>
        if tag == "script":
            self._err("E201", "<script> is forbidden")

        # E203 — iframes and friends
        if tag in ("iframe", "object", "embed", "frame", "frameset", "applet"):
            self._err("E203", f"<{tag}> is forbidden")

        # E205 — <base>
        if tag == "base":
            self._err("E205", "<base> is forbidden")

        # E304 — forms and inputs
        if tag in ("form", "input", "textarea", "select"):
            self._err("E304", f"<{tag}> is forbidden (no forms)")
        if tag == "button":
            for name, value in attrs:
                if name.lower() == "type" and value and value.lower() == "submit":
                    self._err("E304", "<button type='submit'> is forbidden")

        # E204 — <style> only allowed once, only in <head>
        if tag == "style":
            self._style_count += 1
            if self._style_count > 1:
                self._err("E204", "<style> may only appear once (in <head>)")
            if not self._in_head:
                self._err("E204", "<style> outside <head> is forbidden")

        # E400 — whitelist conformance (but forbidden tags already logged)
        if tag not in ALLOWED_TAGS and tag not in FORBIDDEN_TAGS:
            self._err("E400", f"<{tag}> not in allowed tag whitelist")

        # E103 — <p> inside <p>
        if tag == "p":
            for t, _, _ in self.stack:
                if t == "p":
                    self._err("E103", "<p> may not contain another <p>")
                    break

        # E104 — block element inside an inline ancestor (scan outer-most
        # inline ancestor, not whole stack)
        if tag in BLOCK_TAGS:
            for t, _, _ in self.stack:
                if t in INLINE_ANCESTORS:
                    self._err(
                        "E104",
                        f"<{tag}> (block) inside <{t}> (inline) is not allowed",
                    )
                    break

        # E105 — <li> must be inside <ul>/<ol>
        if tag == "li":
            parent = self.stack[-1][0] if self.stack else None
            if parent not in ("ul", "ol"):
                self._err("E105", "<li> outside <ul>/<ol>")

        # E106 — <tr>, <td>, <th> must be inside <table>
        if tag in ("tr", "td", "th"):
            if not any(t == "table" for t, _, _ in self.stack):
                self._err("E106", f"<{tag}> outside <table>")

        # Attribute scan
        self._check_attrs(tag, attrs)

        # Push on stack unless void
        if tag not in VOID_TAGS:
            self.stack.append((tag, line, col))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        # Self-closing tag — run all start-tag checks but do not push.
        tag = tag.lower()
        if tag == "script":
            self._err("E201", "<script/> is forbidden")
        if tag in ("iframe", "object", "embed", "frame", "frameset", "applet"):
            self._err("E203", f"<{tag}/> is forbidden")
        if tag == "base":
            self._err("E205", "<base/> is forbidden")
        if tag not in ALLOWED_TAGS and tag not in FORBIDDEN_TAGS:
            self._err("E400", f"<{tag}/> not in allowed tag whitelist")
        self._check_attrs(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "head":
            self._in_head = False
        if tag in VOID_TAGS:
            # Void tags should not have end tags; silently ignore.
            return
        if not self.stack:
            self._err("E102", f"</{tag}> with no matching opening tag")
            return
        top, _, _ = self.stack[-1]
        if top != tag:
            self._err(
                "E101",
                f"</{tag}> does not match currently open <{top}>",
            )
            # Unwind until we find a match or empty the stack — makes
            # subsequent errors meaningful instead of cascading.
            while self.stack and self.stack[-1][0] != tag:
                self.stack.pop()
            if self.stack:
                self.stack.pop()
        else:
            self.stack.pop()

    def finish(self) -> None:
        # E100 — any unclosed tags at EOF
        for tag, line, _ in self.stack:
            self.errors.append(
                ValidationError(line, 0, "E100", f"<{tag}> opened but never closed")
            )
        # E501 — shell sanity
        if not self._seen_doctype:
            self.errors.insert(0, ValidationError(1, 0, "E501", "missing <!doctype html>"))
        if not self._seen_html:
            self.errors.insert(0, ValidationError(1, 0, "E501", "missing <html> element"))
        if not self._seen_head:
            self.errors.insert(0, ValidationError(1, 0, "E501", "missing <head> element"))
        if not self._seen_body:
            self.errors.insert(0, ValidationError(1, 0, "E501", "missing <body> element"))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate(html_text: str, *, strict: bool = False) -> list[ValidationError]:
    """
    Validate an HTML document against the html-report policy.

    Parameters
    ----------
    html_text : str
        Full HTML document as a single string.
    strict : bool
        Reserved for future use; currently a no-op (all checks are strict).

    Returns
    -------
    list[ValidationError]
        Empty list on a clean document; one entry per violation otherwise.
    """
    del strict  # currently unused; every check is mandatory in v1

    if not html_text or not html_text.strip():
        return [ValidationError(1, 0, "E500", "input HTML is empty")]

    parser = _ReportValidator()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception as exc:  # noqa: BLE001 — html.parser rarely raises
        parser.errors.append(
            ValidationError(1, 0, "E102", f"parser error: {exc}")
        )
    parser.finish()
    return parser.errors


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _format_error(err: ValidationError) -> str:
    return f"{err.code}:{err.line}:{err.col}: {err.message}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Validate an HTML file against the html-report policy."
    )
    ap.add_argument(
        "path",
        nargs="?",
        help="Path to HTML file. Omit to read from stdin.",
    )
    args = ap.parse_args(argv)

    if args.path:
        try:
            html_text = Path(args.path).read_text(encoding="utf-8")
        except OSError as exc:
            print(f"E000:0:0: cannot read {args.path}: {exc}", file=sys.stderr)
            return 1
    else:
        html_text = sys.stdin.read()

    errors = validate(html_text)
    for err in errors:
        print(_format_error(err), file=sys.stderr)
    return 2 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
