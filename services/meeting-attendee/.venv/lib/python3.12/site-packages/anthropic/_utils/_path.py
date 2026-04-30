from __future__ import annotations

import re
from typing import (
    Any,
    Mapping,
    Callable,
)
from urllib.parse import quote

# Matches '.' or '..' where each dot is either literal or percent-encoded (%2e / %2E).
_DOT_SEGMENT_RE = re.compile(r"^(?:\.|%2[eE]){1,2}$")

_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")


def _quote_path_segment_part(value: str) -> str:
    """Percent-encode `value` for use in a URI path segment.

    Considers characters not in `pchar` set from RFC 3986 §3.3 to be unsafe.
    https://datatracker.ietf.org/doc/html/rfc3986#section-3.3
    """
    # quote() already treats unreserved characters (letters, digits, and -._~)
    # as safe, so we only need to add sub-delims, ':', and '@'.
    # Notably, unlike the default `safe` for quote(), / is unsafe and must be quoted.
    return quote(value, safe="!$&'()*+,;=:@")


def _quote_query_part(value: str) -> str:
    """Percent-encode `value` for use in a URI query string.

    Considers &, = and characters not in `query` set from RFC 3986 §3.4 to be unsafe.
    https://datatracker.ietf.org/doc/html/rfc3986#section-3.4
    """
    return quote(value, safe="!$'()*+,;:@/?")


def _quote_fragment_part(value: str) -> str:
    """Percent-encode `value` for use in a URI fragment.

    Considers characters not in `fragment` set from RFC 3986 §3.5 to be unsafe.
    https://datatracker.ietf.org/doc/html/rfc3986#section-3.5
    """
    return quote(value, safe="!$&'()*+,;=:@/?")


def _interpolate(
    template: str,
    values: Mapping[str, Any],
    quoter: Callable[[str], str],
) -> str:
    """Replace {name} placeholders in `template`, quoting each value with `quoter`.

    Placeholder names are looked up in `values`.

    Raises:
        KeyError: If a placeholder is not found in `values`.
    """
    # re.split with a capturing group returns alternating
    # [text, name, text, name, ..., text] elements.
    parts = _PLACEHOLDER_RE.split(template)

    for i in range(1, len(parts), 2):
        name = parts[i]
        if name not in values:
            raise KeyError(f"a value for placeholder {{{name}}} was not provided")
        val = values[name]
        if val is None:
            parts[i] = "null"
        elif isinstance(val, bool):
            parts[i] = "true" if val else "false"
        else:
            parts[i] = quoter(str(values[name]))

    return "".join(parts)


def path_template(template: str, /, **kwargs: Any) -> str:
    """Interpolate {name} placeholders in `template` from keyword arguments.

    Args:
        template: The template string containing {name} placeholders.
        **kwargs: Keyword arguments to interpolate into the template.

    Returns:
        The template with placeholders interpolated and percent-encoded.

        Safe characters for percent-encoding are dependent on the URI component.
        Placeholders in path and fragment portions are percent-encoded where the `segment`
        and `fragment` sets from RFC 3986 respectively are considered safe.
        Placeholders in the query portion are percent-encoded where the `query` set from
        RFC 3986 §3.3 is considered safe except for = and & characters.

    Raises:
        KeyError: If a placeholder is not found in `kwargs`.
        ValueError: If resulting path contains /./ or /../ segments (including percent-encoded dot-segments).
    """
    # Split the template into path, query, and fragment portions.
    fragment_template: str | None = None
    query_template: str | None = None

    rest = template
    if "#" in rest:
        rest, fragment_template = rest.split("#", 1)
    if "?" in rest:
        rest, query_template = rest.split("?", 1)
    path_template = rest

    # Interpolate each portion with the appropriate quoting rules.
    path_result = _interpolate(path_template, kwargs, _quote_path_segment_part)

    # Reject dot-segments (. and ..) in the final assembled path.  The check
    # runs after interpolation so that adjacent placeholders or a mix of static
    # text and placeholders that together form a dot-segment are caught.
    # Also reject percent-encoded dot-segments to protect against incorrectly
    # implemented normalization in servers/proxies.
    for segment in path_result.split("/"):
        if _DOT_SEGMENT_RE.match(segment):
            raise ValueError(f"Constructed path {path_result!r} contains dot-segment {segment!r} which is not allowed")

    result = path_result
    if query_template is not None:
        result += "?" + _interpolate(query_template, kwargs, _quote_query_part)
    if fragment_template is not None:
        result += "#" + _interpolate(fragment_template, kwargs, _quote_fragment_part)

    return result
