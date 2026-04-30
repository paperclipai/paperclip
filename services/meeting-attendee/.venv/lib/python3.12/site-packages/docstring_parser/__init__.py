"""Parse docstrings as per Sphinx notation."""

from .common import (
    Docstring,
    DocstringDeprecated,
    DocstringMeta,
    DocstringParam,
    DocstringRaises,
    DocstringReturns,
    DocstringStyle,
    ParseError,
    RenderingStyle,
)
from .parser import compose, parse, parse_from_object
from .util import combine_docstrings

Style = DocstringStyle  # backwards compatibility

__all__ = [
    "parse",
    "parse_from_object",
    "combine_docstrings",
    "compose",
    "ParseError",
    "Docstring",
    "DocstringMeta",
    "DocstringParam",
    "DocstringRaises",
    "DocstringReturns",
    "DocstringDeprecated",
    "DocstringStyle",
    "RenderingStyle",
    "Style",
]
