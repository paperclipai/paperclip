<!-- 
This file contains instructions for best practices for developing parsers with pyparsing, and can be used by AI agents
when generating Python code using pyparsing.
-->

## Planning
- If not provided or if target language definition is ambiguous, ask for examples of valid strings to be parsed
- Before developing the pyparsing expressions, define a Backus-Naur Form definition and save this in docs/grammar.md. Update this document as changes are made in the parser.

## Implementing
- Import pyparsing using `import pyparsing as pp`, and use that for all pyparsing references.
  - If referencing names from `pyparsing.common`, follow the pyparsing import with "ppc = pp.common" and use `ppc` as the namespace to access `pyparsing.common`.
  - If referencing names from `pyparsing.unicode`, follow the pyparsing import with "ppu = pp.unicode" and use `ppu` as the namespace to access `pyparsing.unicode`.
- When writing parsers that contain recursive elements (using `Forward()` or `infix_notation()`), immediately enable packrat parsing for performance: `pp.ParserElement.enable_packrat()` (call this right after importing pyparsing). See https://pyparsing-docs.readthedocs.io/en/latest/HowToUsePyparsing.html.
  - For recursive grammars, define placeholders with `pp.Forward()` and assign later using the `<<=` operator; give Forwards meaningful names with `set_name()` to improve errors.
- Use PEP8 method and argument names in the pyparsing API (`parse_string`, not `parseString`).
- Do not include expressions for matching whitespace in the grammar. Pyparsing skips whitespace by default.
- For line-oriented grammars where newlines are significant, set skippable whitespace to just spaces/tabs early: `pp.ParserElement.set_default_whitespace_chars(" \t")`, and define `NL = pp.LineEnd().suppress()` to handle line ends explicitly.
- Prefer operator forms for readability: use +, |, ^, ~, etc., instead of explicit And/MatchFirst/Or/Not classes (see Usage notes in https://pyparsing-docs.readthedocs.io/en/latest/HowToUsePyparsing.html).
- Use `set_name()` on all major grammar elements to support railroad diagramming and better error/debug output.
- The grammar should be independently testable, without pulling in separate modules for data structures, evaluation, or command execution.
- Use results names for robust access to parsed data fields; results names should be valid Python identifiers to support attribute-style access on returned ParseResults.
  - Results names should take the place of numeric indexing into parsed results in most places.
  - Define results names using call format not `set_results_name()`, example: `full_name = Word(alphas)("first_name") + Word(alphas)("last_name")`
  - If adding results name to an expression that is contains one more sub-expressions with results names, the expression must be inclused in a Group.
- Prefer `Keyword` over `Literal` for reserved words to avoid partial matches (e.g., `Keyword("for")` will not match the leading "for" in "format").
  - Use `pp.CaselessKeyword`/`pp.CaselessLiteral` when keywords should match regardless of case.
- When the full input must be consumed, call `parse_string` with `parse_all=True`.
- If the grammar must handle comments, define an expression for them and use the `ignore()` method to skip them.
  - Prefer built-ins like `pp.cpp_style_comment` and `pp.python_style_comment` for common comment syntaxes.
- Use pyparsing `Group` to organize sub-expressions. Groups are also important for preserving results names when a sub-expression is used in a `OneOrMore` or `ZeroOrMore` expression.
- Suppress punctuation tokens to keep results clean; a convenient pattern is `LBRACK, RBRACK, LBRACE, RBRACE, COLON = pp.Suppress.using_each("[]{}:")`.
- For comma-separated sequences, prefer `pp.DelimitedList(...)`; wrap with `pp.Optional(...)` to allow empty lists or objects where appropriate.
- For helper sub-expressions used only to build larger expressions, consider `set_name(None)` to keep result dumps uncluttered.
- Use pyparsing `Each()` to define a list of elements that may occur in any order.
  - The '&' operator is the operator form of Each and is often more readable when combining order-independent parts.
- Use parse actions to do parse-time conversion of data from strings to useful data types.
  - Use objects defined in pyparsing.common for common types like integer, real — these already have their conversion parse actions defined.
  - For quoted strings, use `pp.dbl_quoted_string().set_parse_action(pp.remove_quotes)` to unquote automatically.
  - Map reserved words to Python constants per this example for parsing "true" to auto-convert to a Python True: `pp.Keyword("true").set_parse_action(pp.replace_with(True))` (and similarly for false/null/etc.).
  - When you want native Python containers from the parse, use `pp.Group(..., aslist=True)` for lists and `pp.Dict(..., asdict=True)` for dict-like data.
- Use "using_each" with a list of keywords to define keyword constants, instead of separate assignments.
- Choose the appropriate matching method:
  - `parse_string()` parses from the start
  - `search_string()` searches anywhere in the text
  - `scan_string()` yields all matches with positions
  - `transform_string()` is a convenience wrapper around `scan_string` to apply filters or transforms defined in parse actions, to perform batch transforms or conversions of expressions within a larger body of text
- For line suffixes or directives, combine lookahead and slicing helpers: `pp.FollowedBy(...)` with `pp.rest_of_line`; when reusing a base expression with a different parse action, call `.copy()` before applying the new action to avoid side effects.
- When defining a parser to be used in a REPL:
  - add pyparsing `Tag()` elements of the form `Tag("command", <command-name>)` to each command definition to support model construction from parsed commands.
  - define model classes using dataclasses, and use the "command" attribute in the parsed results to identify which model class to create. The model classes can then be used to construct the model from the ParseResults returned by parse_string(). Define the models in a separate parser_models.py file.
- If defining the grammar as part of a Parser class, only the finished grammar needs to be implemented as an instance variable.
- `ParseResults` support "in" testing for results names. Use "in" tests for the existence of results names, not `hasattr()`.
- Avoid left recursion where possible. If you must support left-recursive grammars, enable it with `pp.ParserElement.enable_left_recursion()` and do not enable packrat at the same time (these modes are incompatible).
- Use `pp.SkipTo` as a skipping expression to skip over arbitrary content.
  - For example, `pp.SkipTo(pp.LineEnd())` will skip over all content until the end of the line; add a stop_on argument to SkipTo to stop skipping when a particular string is matched.
  - Use `...` in place of simple SkipTo(expression)

## Testing
- Use the pyparsing `ParserElement.run_tests` method to run mini validation tests.
  - Pass a single multiline string to `run_tests` to test the parser on multiple test input strings, each line is a separate test.
  - You can add comments starting with "#" within the string passed to `run_tests` to document the individual test cases.
  - To pass test input strings that span multiple lines, pass the test input strings as a list of strings.
  - Pass `parse_all=True` to `run_tests` to test that the entire input is consumed.
- When generating unit tests for the parser:
  - generate tests that include presence and absence of optional elements
  - use the methods in the mixin class pyparsing.testing.TestParseResultsAsserts to easily define expression, test input string, and expected results
  - do not generate tests for invalid data

## Debugging
- If troubleshooting parse actions, use pyparsing's `trace_parse_action` decorator to echo arguments and return value
- During development, call `pp.autoname_elements()` to auto-assign names to unnamed expressions to improve `dump()` and error messages.
- Sub-expressions can be tested in isolation using `ParserElement.matches()`
- When defined out of order, Literals can mistakenly match fragments: `Literal("for")` will match the leading "for" in "format". Can be corrected by using `Keyword` instead of `Literal`.
- Dump the parsed results using `ParseResults.dump()`, `ParseResults.pprint()`, or `repr(ParseResults)`.
