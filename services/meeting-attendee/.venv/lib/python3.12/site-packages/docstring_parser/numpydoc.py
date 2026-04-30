"""Numpydoc-style docstring parsing.

:see: https://numpydoc.readthedocs.io/en/latest/format.html
"""

import inspect
import itertools
import re
import typing as T
from textwrap import dedent

from .common import (
    Docstring,
    DocstringDeprecated,
    DocstringExample,
    DocstringMeta,
    DocstringParam,
    DocstringRaises,
    DocstringReturns,
    DocstringStyle,
    RenderingStyle,
)


def _pairwise(iterable: T.Iterable, end=None) -> T.Iterable:
    left, right = itertools.tee(iterable)
    next(right, None)
    return itertools.zip_longest(left, right, fillvalue=end)


def _clean_str(string: str) -> T.Optional[str]:
    string = string.strip()
    if len(string) > 0:
        return string
    return None


KV_REGEX = re.compile(r"^[^\s].*$", flags=re.M)
PARAM_KEY_REGEX = re.compile(r"^(?P<name>.*?)(?:\s*:\s*(?P<type>.*?))?$")
PARAM_OPTIONAL_REGEX = re.compile(r"(?P<type>.*?)(?:, optional|\(optional\))$")

# Ideally, default value will be specified in the type declaration,
# for which the following are supported:
#
#   copy : bool, default True
#   copy : bool, default=True
#   copy : bool, default: True
#
PARAM_DEFAULT_REGEX = re.compile(
    r"(?P<type>.*?)(?:, default|\(default\))(?: | |=| = |= |: |)*(?P<value>.*)$"  # pylint: disable=C0301
)

# If the default value isn't specified in the type declaration,
# it might be in the description. There isn't any formal grammar for this
# in numpydoc, but we can make some educated guesses.
PARAM_DEFAULT_REGEX_IN_DESC = re.compile(
    r"(?<!\S)[Dd]efault(?:s to |(?:\s*(?:is|[=:])\s*|\s+))(?P<value>(?:['\"]).*?(?:['\"])|[\w\-\.]*\w)"  # pylint: disable=C0301
)

RETURN_KEY_REGEX = re.compile(r"^(?:(?P<name>.*?)\s*:\s*)?(?P<type>.*?)$")


class Section:
    """Numpydoc section parser.

    :param title: section title. For most sections, this is a heading like
                  "Parameters" which appears on its own line, underlined by
                  en-dashes ('-') on the following line.
    :param key: meta key string. In the parsed ``DocstringMeta`` instance this
                will be the first element of the ``args`` attribute list.
    """

    def __init__(self, title: str, key: str) -> None:
        self.title = title
        self.key = key

    @property
    def title_pattern(self) -> str:
        """Regular expression pattern matching this section's header.

        This pattern will match this instance's ``title`` attribute in
        an anonymous group.
        """
        dashes = "-" * len(self.title)
        return rf"^({self.title})\s*?\n{dashes}\s*$"

    def parse(self, text: str) -> T.Iterable[DocstringMeta]:
        """Parse ``DocstringMeta`` objects from the body of this section.

        :param text: section body text. Should be cleaned with
                     ``inspect.cleandoc`` before parsing.
        """
        yield DocstringMeta([self.key], description=_clean_str(text))


class _KVSection(Section):
    """Base parser for numpydoc sections with key-value syntax.

    E.g. sections that look like this:
        key
            value
        key2 : type
            values can also span...
            ... multiple lines
    """

    def _parse_item(self, key: str, value: str) -> DocstringMeta:
        pass

    def parse(self, text: str) -> T.Iterable[DocstringMeta]:
        for match, next_match in _pairwise(KV_REGEX.finditer(text)):
            start = match.end()
            end = next_match.start() if next_match is not None else None
            value = text[start:end]
            yield self._parse_item(
                key=match.group(), value=inspect.cleandoc(value)
            )


class _SphinxSection(Section):
    """Base parser for numpydoc sections with sphinx-style syntax.

    E.g. sections that look like this:
        .. title:: something
            possibly over multiple lines
    """

    @property
    def title_pattern(self) -> str:
        return rf"^\.\.\s*({self.title})\s*::"


class ParamSection(_KVSection):
    """Parser for numpydoc parameter sections.

    E.g. any section that looks like this:
        arg_name
            arg_description
        arg_2 : type, optional
            descriptions can also span...
            ... multiple lines
    """

    def _parse_item(self, key: str, value: str) -> DocstringParam:
        match = PARAM_KEY_REGEX.match(key)
        arg_name = type_name = is_optional = default = None
        if match is not None:
            arg_name = match.group("name")
            type_name = match.group("type")
            if type_name is not None:
                optional_match = PARAM_OPTIONAL_REGEX.match(type_name)
                if optional_match is not None:
                    type_name = optional_match.group("type")
                    is_optional = True
                else:
                    is_optional = False

                default_match = PARAM_DEFAULT_REGEX.match(type_name)
                if default_match is not None:
                    is_optional = True
                    type_name = default_match.group("type")
                    default = default_match.group("value")

        # If the default wasn't specifified in the type declaration,
        # try and see if we can find it in the description.
        if len(value) > 0 and default is None:
            default_match = PARAM_DEFAULT_REGEX_IN_DESC.search(value)
            if default_match is not None:
                default = default_match.group("value")

        return DocstringParam(
            args=[self.key, arg_name],
            description=_clean_str(value),
            arg_name=arg_name,
            type_name=type_name,
            is_optional=is_optional,
            default=default,
        )


class RaisesSection(_KVSection):
    """Parser for numpydoc raises sections.

    E.g. any section that looks like this:
        ValueError
            A description of what might raise ValueError
    """

    def _parse_item(self, key: str, value: str) -> DocstringRaises:
        return DocstringRaises(
            args=[self.key, key],
            description=_clean_str(value),
            type_name=key if len(key) > 0 else None,
        )


class ReturnsSection(_KVSection):
    """Parser for numpydoc returns sections.

    E.g. any section that looks like this:
        return_name : type
            A description of this returned value
        another_type
            Return names are optional, types are required
    """

    is_generator = False

    def _parse_item(self, key: str, value: str) -> DocstringReturns:
        match = RETURN_KEY_REGEX.match(key)
        if match is not None:
            return_name = match.group("name")
            type_name = match.group("type")
        else:
            return_name = None
            type_name = None

        return DocstringReturns(
            args=[self.key],
            description=_clean_str(value),
            type_name=type_name,
            is_generator=self.is_generator,
            return_name=return_name,
        )


class YieldsSection(ReturnsSection):
    """Parser for numpydoc generator "yields" sections."""

    is_generator = True


class DeprecationSection(_SphinxSection):
    """Parser for numpydoc "deprecation warning" sections."""

    def parse(self, text: str) -> T.Iterable[DocstringDeprecated]:
        version, desc, *_ = text.split(sep="\n", maxsplit=1) + [None, None]

        if desc is not None:
            desc = _clean_str(inspect.cleandoc(desc))

        yield DocstringDeprecated(
            args=[self.key], description=desc, version=_clean_str(version)
        )


class ExamplesSection(Section):
    """Parser for numpydoc examples sections.

    E.g. any section that looks like this:
        >>> import numpy.matlib
        >>> np.matlib.empty((2, 2))    # filled with random data
        matrix([[  6.76425276e-320,   9.79033856e-307], # random
                [  7.39337286e-309,   3.22135945e-309]])
        >>> np.matlib.empty((2, 2), dtype=int)
        matrix([[ 6600475,        0], # random
                [ 6586976, 22740995]])
    """

    def parse(self, text: str) -> T.Iterable[DocstringMeta]:
        """Parse ``DocstringExample`` objects from the body of this section.

        :param text: section body text. Should be cleaned with
                     ``inspect.cleandoc`` before parsing.
        """
        lines = dedent(text).strip().splitlines()
        while lines:
            snippet_lines = []
            description_lines = []
            while lines:
                if not lines[0].startswith(">>>"):
                    break
                snippet_lines.append(lines.pop(0))
            while lines:
                if lines[0].startswith(">>>"):
                    break
                description_lines.append(lines.pop(0))
            yield DocstringExample(
                [self.key],
                snippet="\n".join(snippet_lines) if snippet_lines else None,
                description="\n".join(description_lines),
            )


DEFAULT_SECTIONS = [
    ParamSection("Parameters", "param"),
    ParamSection("Params", "param"),
    ParamSection("Arguments", "param"),
    ParamSection("Args", "param"),
    ParamSection("Other Parameters", "other_param"),
    ParamSection("Other Params", "other_param"),
    ParamSection("Other Arguments", "other_param"),
    ParamSection("Other Args", "other_param"),
    ParamSection("Receives", "receives"),
    ParamSection("Receive", "receives"),
    RaisesSection("Raises", "raises"),
    RaisesSection("Raise", "raises"),
    RaisesSection("Warns", "warns"),
    RaisesSection("Warn", "warns"),
    ParamSection("Attributes", "attribute"),
    ParamSection("Attribute", "attribute"),
    ReturnsSection("Returns", "returns"),
    ReturnsSection("Return", "returns"),
    YieldsSection("Yields", "yields"),
    YieldsSection("Yield", "yields"),
    ExamplesSection("Examples", "examples"),
    ExamplesSection("Example", "examples"),
    Section("Warnings", "warnings"),
    Section("Warning", "warnings"),
    Section("See Also", "see_also"),
    Section("Related", "see_also"),
    Section("Notes", "notes"),
    Section("Note", "notes"),
    Section("References", "references"),
    Section("Reference", "references"),
    DeprecationSection("deprecated", "deprecation"),
]


class NumpydocParser:
    """Parser for numpydoc-style docstrings."""

    def __init__(self, sections: T.Optional[T.Dict[str, Section]] = None):
        """Setup sections.

        :param sections: Recognized sections or None to defaults.
        """
        sections = sections or DEFAULT_SECTIONS
        self.sections = {s.title: s for s in sections}
        self._setup()

    def _setup(self):
        self.titles_re = re.compile(
            r"|".join(s.title_pattern for s in self.sections.values()),
            flags=re.M,
        )

    def add_section(self, section: Section):
        """Add or replace a section.

        :param section: The new section.
        """

        self.sections[section.title] = section
        self._setup()

    def parse(self, text: T.Optional[str]) -> Docstring:
        """Parse the numpy-style docstring into its components.

        :returns: parsed docstring
        """
        ret = Docstring(style=DocstringStyle.NUMPYDOC)
        if not text:
            return ret

        # Clean according to PEP-0257
        text = inspect.cleandoc(text)

        # Find first title and split on its position
        match = self.titles_re.search(text)
        if match:
            desc_chunk = text[: match.start()]
            meta_chunk = text[match.start() :]
        else:
            desc_chunk = text
            meta_chunk = ""

        # Break description into short and long parts
        parts = desc_chunk.split("\n", 1)
        ret.short_description = parts[0] or None
        if len(parts) > 1:
            long_desc_chunk = parts[1] or ""
            ret.blank_after_short_description = long_desc_chunk.startswith(
                "\n"
            )
            ret.blank_after_long_description = long_desc_chunk.endswith("\n\n")
            ret.long_description = long_desc_chunk.strip() or None

        for match, nextmatch in _pairwise(self.titles_re.finditer(meta_chunk)):
            title = next(g for g in match.groups() if g is not None)
            factory = self.sections[title]

            # section chunk starts after the header,
            # ends at the start of the next header
            start = match.end()
            end = nextmatch.start() if nextmatch is not None else None
            ret.meta.extend(factory.parse(meta_chunk[start:end]))

        return ret


def parse(text: T.Optional[str]) -> Docstring:
    """Parse the numpy-style docstring into its components.

    :returns: parsed docstring
    """
    return NumpydocParser().parse(text)


def compose(
    # pylint: disable=W0613
    docstring: Docstring,
    rendering_style: RenderingStyle = RenderingStyle.COMPACT,
    indent: str = "    ",
) -> str:
    """Render a parsed docstring into docstring text.

    :param docstring: parsed docstring representation
    :param rendering_style: the style to render docstrings
    :param indent: the characters used as indentation in the docstring string
    :returns: docstring text
    """

    def process_one(
        one: T.Union[DocstringParam, DocstringReturns, DocstringRaises],
    ):
        if isinstance(one, DocstringParam):
            head = one.arg_name
        elif isinstance(one, DocstringReturns):
            head = one.return_name
        else:
            head = None

        if one.type_name and head:
            head += f" : {one.type_name}"
        elif one.type_name:
            head = one.type_name
        elif not head:
            head = ""

        # If this is a parameter, check if it's optional.
        # If it is and there's a not-None default, include that in the type
        # declaration, otherwise just mark it as optional.
        if isinstance(one, DocstringParam):
            if one.default not in [None, "None"]:
                head += f", default={one.default}"
            elif one.is_optional or one.default == "None":
                head += ", optional"

        if one.description:
            body = f"\n{indent}".join([head] + one.description.splitlines())
            parts.append(body)
        else:
            parts.append(head)

    def process_sect(name: str, args: T.List[T.Any]):
        if args:
            parts.append("")
            parts.append(name)
            parts.append("-" * len(parts[-1]))
            for arg in args:
                process_one(arg)

    parts: T.List[str] = []
    if docstring.short_description:
        parts.append(docstring.short_description)
    if docstring.blank_after_short_description:
        parts.append("")

    if docstring.deprecation:
        first = ".. deprecated::"
        if docstring.deprecation.version:
            first += f" {docstring.deprecation.version}"
        if docstring.deprecation.description:
            rest = docstring.deprecation.description.splitlines()
        else:
            rest = []
        sep = f"\n{indent}"
        parts.append(sep.join([first] + rest))

    if docstring.long_description:
        parts.append(docstring.long_description)
    if docstring.blank_after_long_description:
        parts.append("")

    process_sect(
        "Parameters",
        [item for item in docstring.params or [] if item.args[0] == "param"],
    )

    process_sect(
        "Attributes",
        [
            item
            for item in docstring.params or []
            if item.args[0] == "attribute"
        ],
    )

    process_sect(
        "Returns",
        [
            item
            for item in docstring.many_returns or []
            if not item.is_generator
        ],
    )

    process_sect(
        "Yields",
        [item for item in docstring.many_returns or [] if item.is_generator],
    )

    if docstring.returns and not docstring.many_returns:
        ret = docstring.returns
        parts.append("Yields" if ret else "Returns")
        parts.append("-" * len(parts[-1]))
        process_one(ret)

    process_sect(
        "Receives",
        [
            item
            for item in docstring.params or []
            if item.args[0] == "receives"
        ],
    )

    process_sect(
        "Other Parameters",
        [
            item
            for item in docstring.params or []
            if item.args[0] == "other_param"
        ],
    )

    process_sect(
        "Raises",
        [item for item in docstring.raises or [] if item.args[0] == "raises"],
    )

    process_sect(
        "Warns",
        [item for item in docstring.raises or [] if item.args[0] == "warns"],
    )

    if len(docstring.examples) > 0:
        parts.append("")
        parts.append("Examples")
        parts.append("--------")
        for example in docstring.examples:
            if example.snippet:
                parts.append(example.snippet)
            if example.description:
                parts.append(example.description)

    for meta in docstring.meta:
        if isinstance(
            meta,
            (
                DocstringDeprecated,
                DocstringParam,
                DocstringReturns,
                DocstringRaises,
                DocstringExample,
            ),
        ):
            continue  # Already handled

        parts.append("")
        parts.append(meta.args[0].replace("_", "").title())
        parts.append("-" * len(meta.args[0]))

        if meta.description:
            parts.append(meta.description)

    return "\n".join(parts)
