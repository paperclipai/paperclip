"""
Compatibility helpers for supporting pyparsing v2 and v3 APIs.
"""

from __future__ import annotations

from typing import Callable, Dict, Type, cast

import pyparsing

ParseResults = pyparsing.ParseResults
ParserElement = pyparsing.ParserElement


_RAW_VERSION = getattr(pyparsing, "__version__", "0")
try:
    PYPARSING_MAJOR_VERSION = int(_RAW_VERSION.split(".", 1)[0])
except (TypeError, ValueError):
    PYPARSING_MAJOR_VERSION = 0

PYPARSING_V3 = PYPARSING_MAJOR_VERSION >= 3

_ParserFactory = Callable[..., ParserElement]
_ParserTransform = Callable[..., ParserElement]

DelimitedList: _ParserFactory
original_text_for: _ParserTransform
rest_of_line: ParserElement

if PYPARSING_V3:
    DelimitedList = pyparsing.DelimitedList
    original_text_for = pyparsing.original_text_for
    rest_of_line = pyparsing.rest_of_line
else:
    DelimitedList = pyparsing.delimitedList
    original_text_for = pyparsing.originalTextFor
    rest_of_line = pyparsing.restOfLine


def _alias_instance_method(klass: Type[object], new_name: str, old_name: str) -> None:
    if hasattr(klass, new_name) or not hasattr(klass, old_name):
        return

    def _method(self: object, *args: object, **kwargs: object) -> object:
        # Resolve old_name on self so subclass overrides are preserved.
        method = cast(Callable[..., object], getattr(self, old_name))
        return method(*args, **kwargs)

    setattr(klass, new_name, _method)


def _alias_static_method(klass: Type[object], new_name: str, old_name: str) -> None:
    if hasattr(klass, new_name) or not hasattr(klass, old_name):
        return

    old_method = cast(Callable[..., object], getattr(klass, old_name))

    def _method(*args: object, **kwargs: object) -> object:
        return old_method(*args, **kwargs)

    setattr(klass, new_name, staticmethod(_method))


_alias_instance_method(ParserElement, "set_parse_action", "setParseAction")
_alias_instance_method(ParserElement, "add_parse_action", "addParseAction")
_alias_instance_method(ParserElement, "leave_whitespace", "leaveWhitespace")
_alias_instance_method(ParserElement, "set_name", "setName")
_alias_instance_method(ParserElement, "set_results_name", "setResultsName")
_alias_instance_method(ParserElement, "parse_with_tabs", "parseWithTabs")
_alias_instance_method(ParserElement, "search_string", "searchString")
_alias_static_method(
    ParserElement,
    "set_default_whitespace_chars",
    "setDefaultWhitespaceChars",
)

if not hasattr(ParserElement, "parse_string"):

    def _parse_string(
        self: ParserElement,
        instring: str,
        parse_all: bool = False,
        *,
        parseAll: bool = False,
    ) -> ParseResults:
        if parseAll:
            parse_all = parseAll
        parser = cast(Callable[..., ParseResults], getattr(self, "parseString"))
        return parser(instring, parseAll=parse_all)

    setattr(ParserElement, "parse_string", _parse_string)


_alias_instance_method(ParseResults, "as_list", "asList")


def combine_join_kwargs(value: str) -> Dict[str, str]:
    if PYPARSING_V3:
        return {"join_string": value}
    return {"joinString": value}
