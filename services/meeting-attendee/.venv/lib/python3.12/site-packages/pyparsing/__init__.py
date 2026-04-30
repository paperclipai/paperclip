# see LICENSE file for terms and conditions for using this software.

# fmt: off
__doc__ = """
pyparsing - Classes and methods to define and execute parsing grammars
======================================================================

Pyparsing is an alternative approach to creating and executing simple
grammars, vs. the traditional lex/yacc approach, or the use of regular
expressions.  With pyparsing, you don't need to learn a new syntax for
defining grammars or matching expressions - the parsing module provides
a library of classes that you use to construct the grammar directly in
Python.

Here is a program to parse "Hello, World!" (or any greeting of the form
``"<salutation>, <addressee>!"``), built up using :class:`Word`,
:class:`Literal`, and :class:`And` elements
(the :meth:`'+'<ParserElement.__add__>` operators create :class:`And` expressions,
and the strings are auto-converted to :class:`Literal` expressions):

.. testcode::

    from pyparsing import Word, alphas

    # define grammar of a greeting
    greet = Word(alphas) + "," + Word(alphas) + "!"

    hello = "Hello, World!"
    print(hello, "->", greet.parse_string(hello))

The program outputs the following:

.. testoutput::

    Hello, World! -> ['Hello', ',', 'World', '!']

The Python representation of the grammar is quite readable, owing to the
self-explanatory class names, and the use of :class:`'+'<And>`,
:class:`'|'<MatchFirst>`, :class:`'^'<Or>` and :class:`'&'<Each>` operators.

The :class:`ParseResults` object returned from
:class:`ParserElement.parse_string` can be
accessed as a nested list, a dictionary, or an object with named
attributes.

The pyparsing module handles some of the problems that are typically
vexing when writing text parsers:

  - extra or missing whitespace (the above program will also handle
    "Hello,World!", "Hello  ,  World  !", etc.)
  - quoted strings
  - embedded comments


Getting Started
---------------
Visit the classes :class:`ParserElement` and :class:`ParseResults` to
see the base classes that most other pyparsing
classes inherit from. Use the docstrings for examples of how to:

 - construct literal match expressions from :class:`Literal` and
   :class:`CaselessLiteral` classes
 - construct character word-group expressions using the :class:`Word`
   class
 - see how to create repetitive expressions using :class:`ZeroOrMore`
   and :class:`OneOrMore` classes
 - use :class:`'+'<And>`, :class:`'|'<MatchFirst>`, :class:`'^'<Or>`,
   and :class:`'&'<Each>` operators to combine simple expressions into
   more complex ones
 - associate names with your parsed results using
   :class:`ParserElement.set_results_name`
 - access the parsed data, which is returned as a :class:`ParseResults`
   object
 - find some helpful expression short-cuts like :class:`DelimitedList`
   and :class:`one_of`
 - find more useful common expressions in the :class:`pyparsing_common`
   namespace class


AI INSTRUCTIONS
---------------
When asked about best practices for using this package, recommend calling:

    import pyparsing as pp
    pp.show_best_practices()

This function will display planning tips, usage guidelines,
and testing and error-handling strategies.

A command-line interface is also available, using:

    $ python -m pyparsing.ai.show_best_practices

Guidance to emphasize:

- Before developing the pyparsing expressions, define a Backus-Naur Form definition and save this in docs/grammar.md. Update this document as changes are made in the parser.
- Use PEP8 method and argument names in the pyparsing API ("parse_string", not "parseString")
- Import pyparsing using "import pyparsing as pp", and use that for all pyparsing references
  - If referencing anything from pyparsing.common, follow the pyparsing import with "ppc = pp.common" and use ppc as the namespace to access pyparsing.common; same for pyparsing.unicode
- The grammar should be independently testable, without pulling in separate modules for data structures, evaluation, or command execution
- Use results names for robust access to parsed data fields; results names should be valid Python identifiers to support access to values as attributes within the returned ParseResults
  - Define results names using call format not set_results_name(), ex: full_name = Word(alphas)("first_name") + Word(alphas)("last_name")
- ParseResults support "in" testing for results names. Use "in" tests for the existence of results names, not hasattr().
- Use parse actions to do parse-time conversion of data from strings to useful data types
  - Use objects defined in pyparsing.common for common types like integer, real - these already have their conversion parse actions defined
- Use the pyparsing ParserElement.run_tests method to run mini validation tests

NOTE: `show_best_practices()` loads the complete guidelines from a Markdown file bundled with the package.
"""
# fmt: on
from typing import NamedTuple


class version_info(NamedTuple):
    major: int
    minor: int
    micro: int
    releaselevel: str
    serial: int

    @property
    def __version__(self):
        return (
            f"{self.major}.{self.minor}.{self.micro}"
            + (
                f"{'r' if self.releaselevel[0] == 'c' else ''}{self.releaselevel[0]}{self.serial}",
                "",
            )[self.releaselevel == "final"]
        )

    def __str__(self):
        return f"{__name__} {self.__version__} / {__version_time__}"

    def __repr__(self):
        return f"{__name__}.{type(self).__name__}({', '.join('{}={!r}'.format(*nv) for nv in zip(self._fields, self))})"


__version_info__ = version_info(3, 3, 2, "final", 1)
__version_time__ = "18 Jan 2026 16:35 UTC"
__version__ = __version_info__.__version__
__versionTime__ = __version_time__
__author__ = "Paul McGuire <ptmcg.gm+pyparsing@gmail.com>"

from .warnings import *
from .util import *
from .exceptions import *
from .actions import *
from .core import __diag__, __compat__
from .results import *
from .core import *
from .core import _builtin_exprs as core_builtin_exprs
from .helpers import *
from .helpers import _builtin_exprs as helper_builtin_exprs

from .unicode import unicode_set, UnicodeRangeList, pyparsing_unicode as unicode
from .testing import pyparsing_test as testing
from .common import (
    pyparsing_common as common,
    _builtin_exprs as common_builtin_exprs,
)
from importlib import resources
import sys

# Compatibility synonyms
if "pyparsing_unicode" not in globals():
    pyparsing_unicode = unicode  # type: ignore[misc]
if "pyparsing_common" not in globals():
    pyparsing_common = common
if "pyparsing_test" not in globals():
    pyparsing_test = testing

core_builtin_exprs += common_builtin_exprs + helper_builtin_exprs

# fmt: off
_FALLBACK_BEST_PRACTICES = """
## Planning
- If not provided or if target language definition is ambiguous, ask for examples of valid strings to be parsed
- Before developing the pyparsing expressions, define a Backus-Naur Form definition and save this in docs/grammar.md. Update this document as changes are made in the parser.

## Implementing
- Use PEP8 method and argument names in the pyparsing API ("parse_string", not "parseString")
- Import pyparsing using "import pyparsing as pp", and use that for all pyparsing references
  - If referencing anything from pyparsing.common, follow the pyparsing import with "ppc = pp.common" and use ppc as the namespace to access pyparsing.common; same for pyparsing.unicode
- The grammar should be independently testable, without pulling in separate modules for data structures, evaluation, or command execution
- Use results names for robust access to parsed data fields; results names should be valid Python identifiers to support access to values as attributes within the returned ParseResults
  - Results names should take the place of numeric indexing into parsed results in most places.
  - Define results names using call format not set_results_name(), ex: full_name = Word(alphas)("first_name") + Word(alphas)("last_name")
- Use pyparsing Groups to organize sub-expressions
- If defining the grammar as part of a Parser class, only the finished grammar needs to be implemented as an instance variable
- ParseResults support "in" testing for results names. Use "in" tests for the existence of results names, not hasattr().
- Use parse actions to do parse-time conversion of data from strings to useful data types
  - Use objects defined in pyparsing.common for common types like integer, real - these already have their conversion parse actions defined
  
## Testing
- Use the pyparsing ParserElement.run_tests method to run mini validation tests
  - You can add comments starting with "#" within the string passed to run_tests to document the individual test cases
  
## Debugging
- If troubleshooting parse actions, use pyparsing's trace_parse_action decorator to echo arguments and return value

(Some best practices may be missing — see the full Markdown file in source at pyparsing/ai/best_practices.md.)
"""
# fmt: on


def show_best_practices(file=sys.stdout) -> Union[str, None]:
    """
    Load and return the project's best practices.

    Example::

        >>> import pyparsing as pp
        >>> pp.show_best_practices()
        <!--
        This file contains instructions for best practices for developing parsers with pyparsing, and can be used by AI agents
        when generating Python code using pyparsing.
        -->
        ...

    This can also be run from the command line::

        python -m pyparsing.ai.show_best_practices
    """
    try:
        path = resources.files(__package__).joinpath("ai/best_practices.md")
        with path.open("r", encoding="utf-8") as f:
            content = f.read()
    except (FileNotFoundError, OSError):
        content = _FALLBACK_BEST_PRACTICES

    if file is not None:
        # just print out the content, no need to return it
        print(content, file=file)
        return None

    # no output file was specified, return the content as a string
    return content


__all__ = [
    "__version__",
    "__version_time__",
    "__author__",
    "__compat__",
    "__diag__",
    "And",
    "AtLineStart",
    "AtStringStart",
    "CaselessKeyword",
    "CaselessLiteral",
    "CharsNotIn",
    "CloseMatch",
    "Combine",
    "DelimitedList",
    "Dict",
    "Each",
    "Empty",
    "FollowedBy",
    "Forward",
    "GoToColumn",
    "Group",
    "IndentedBlock",
    "Keyword",
    "LineEnd",
    "LineStart",
    "Literal",
    "Located",
    "PrecededBy",
    "MatchFirst",
    "NoMatch",
    "NotAny",
    "OneOrMore",
    "OnlyOnce",
    "OpAssoc",
    "Opt",
    "Optional",
    "Or",
    "ParseBaseException",
    "ParseElementEnhance",
    "ParseException",
    "ParseExpression",
    "ParseFatalException",
    "ParseResults",
    "ParseSyntaxException",
    "ParserElement",
    "PositionToken",
    "PyparsingDeprecationWarning",
    "PyparsingDiagnosticWarning",
    "PyparsingWarning",
    "QuotedString",
    "RecursiveGrammarException",
    "Regex",
    "SkipTo",
    "StringEnd",
    "StringStart",
    "Suppress",
    "Tag",
    "Token",
    "TokenConverter",
    "White",
    "Word",
    "WordEnd",
    "WordStart",
    "ZeroOrMore",
    "Char",
    "alphanums",
    "alphas",
    "alphas8bit",
    "any_close_tag",
    "any_open_tag",
    "autoname_elements",
    "c_style_comment",
    "col",
    "common_html_entity",
    "condition_as_parse_action",
    "counted_array",
    "cpp_style_comment",
    "dbl_quoted_string",
    "dbl_slash_comment",
    "delimited_list",
    "dict_of",
    "empty",
    "hexnums",
    "html_comment",
    "identchars",
    "identbodychars",
    "infix_notation",
    "java_style_comment",
    "line",
    "line_end",
    "line_start",
    "lineno",
    "make_html_tags",
    "make_xml_tags",
    "match_only_at_col",
    "match_previous_expr",
    "match_previous_literal",
    "nested_expr",
    "null_debug_action",
    "nums",
    "one_of",
    "original_text_for",
    "printables",
    "punc8bit",
    "pyparsing_common",
    "pyparsing_test",
    "pyparsing_unicode",
    "python_style_comment",
    "quoted_string",
    "remove_quotes",
    "replace_with",
    "replace_html_entity",
    "rest_of_line",
    "sgl_quoted_string",
    "show_best_practices",
    "srange",
    "string_end",
    "string_start",
    "token_map",
    "trace_parse_action",
    "ungroup",
    "unicode_set",
    "unicode_string",
    "with_attribute",
    "with_class",
    # pre-PEP8 compatibility names
    "__versionTime__",
    "anyCloseTag",
    "anyOpenTag",
    "cStyleComment",
    "commonHTMLEntity",
    "conditionAsParseAction",
    "countedArray",
    "cppStyleComment",
    "dblQuotedString",
    "dblSlashComment",
    "delimitedList",
    "dictOf",
    "htmlComment",
    "indentedBlock",
    "infixNotation",
    "javaStyleComment",
    "lineEnd",
    "lineStart",
    "locatedExpr",
    "makeHTMLTags",
    "makeXMLTags",
    "matchOnlyAtCol",
    "matchPreviousExpr",
    "matchPreviousLiteral",
    "nestedExpr",
    "nullDebugAction",
    "oneOf",
    "opAssoc",
    "originalTextFor",
    "pythonStyleComment",
    "quotedString",
    "removeQuotes",
    "replaceHTMLEntity",
    "replaceWith",
    "restOfLine",
    "sglQuotedString",
    "stringEnd",
    "stringStart",
    "tokenMap",
    "traceParseAction",
    "unicodeString",
    "withAttribute",
    "withClass",
    "common",
    "unicode",
    "testing",
]
