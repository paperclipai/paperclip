"""
Utility functions and objects to ease Python 2/3 compatibility,
and different versions of support libraries.
"""

from __future__ import annotations

import codecs
import re
import warnings
from typing import Match


def cast_bytes(s, enc="utf-8"):
    if isinstance(s, str):
        return s.encode(enc)
    return s


def ascii(stream):
    return codecs.getreader("ascii")(stream)


def bopen(*args, **kwargs):
    # type error: No overload variant of "open" matches argument types "Tuple[Any, ...]", "str", "Dict[str, Any]"
    return open(*args, mode="rb", **kwargs)  # type: ignore[call-overload]


long_type = int


def sign(n):
    if n < 0:
        return -1
    if n > 0:
        return 1
    return 0


r_unicodeEscape = re.compile(r"(\\u[0-9A-Fa-f]{4}|\\U[0-9A-Fa-f]{8})")  # noqa: N816


def _unicodeExpand(s):  # noqa: N802
    return r_unicodeEscape.sub(lambda m: chr(int(m.group(0)[2:], 16)), s)


def decodeStringEscape(s):  # noqa: N802
    warnings.warn(
        DeprecationWarning(
            "rdflib.compat.decodeStringEscape() is deprecated, "
            "it will be removed in rdflib 7.0.0. "
            "This function is not used anywhere in rdflib anymore "
            "and the utility that it does provide is not implemented correctly."
        )
    )
    r"""
    s is byte-string - replace \ escapes in string
    """

    s = s.replace("\\t", "\t")
    s = s.replace("\\n", "\n")
    s = s.replace("\\r", "\r")
    s = s.replace("\\b", "\b")
    s = s.replace("\\f", "\f")
    s = s.replace('\\"', '"')
    s = s.replace("\\'", "'")
    s = s.replace("\\\\", "\\")

    return s
    # return _unicodeExpand(s) # hmm - string escape doesn't do unicode escaping


_string_escape_map = {
    "t": "\t",
    "b": "\b",
    "n": "\n",
    "r": "\r",
    "f": "\f",
    '"': '"',
    "'": "'",
    "\\": "\\",
}


def _turtle_escape_subber(match: Match[str]) -> str:
    smatch, umatch = match.groups()
    if smatch is not None:
        return _string_escape_map[smatch]
    else:
        return chr(int(umatch[1:], 16))


_turtle_escape_pattern = re.compile(
    r"""\\(?:([tbnrf"'\\])|(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))""",
)


def decodeUnicodeEscape(escaped: str) -> str:  # noqa: N802
    if "\\" not in escaped:
        # Most of times, there are no backslashes in strings.
        return escaped
    return _turtle_escape_pattern.sub(_turtle_escape_subber, escaped)
