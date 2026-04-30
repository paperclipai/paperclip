"""
babel.util
~~~~~~~~~~

Various utility classes and functions.

:copyright: (c) 2013-2026 by the Babel Team.
:license: BSD, see LICENSE for more details.
"""

from __future__ import annotations

import codecs
import datetime
import os
import re
import textwrap
import warnings
from collections.abc import Generator, Iterable
from typing import IO, Any, TypeVar

from babel import dates, localtime

missing = object()

_T = TypeVar("_T")


def distinct(iterable: Iterable[_T]) -> Generator[_T, None, None]:
    """Yield all items in an iterable collection that are distinct.

    Unlike when using sets for a similar effect, the original ordering of the
    items in the collection is preserved by this function.

    >>> print(list(distinct([1, 2, 1, 3, 4, 4])))
    [1, 2, 3, 4]
    >>> print(list(distinct('foobar')))
    ['f', 'o', 'b', 'a', 'r']

    :param iterable: the iterable collection providing the data
    """
    seen = set()
    for item in iter(iterable):
        if item not in seen:
            yield item
            seen.add(item)


# Regexp to match python magic encoding line
PYTHON_MAGIC_COMMENT_re = re.compile(
    rb'[ \t\f]* \# .* coding[=:][ \t]*([-\w.]+)',
    flags=re.VERBOSE,
)


def parse_encoding(fp: IO[bytes]) -> str | None:
    """Deduce the encoding of a source file from magic comment.

    It does this in the same way as the `Python interpreter`__

    .. __: https://docs.python.org/3.4/reference/lexical_analysis.html#encoding-declarations

    The ``fp`` argument should be a seekable file object.

    (From Jeff Dairiki)
    """
    pos = fp.tell()
    fp.seek(0)
    try:
        line1 = fp.readline()
        has_bom = line1.startswith(codecs.BOM_UTF8)
        if has_bom:
            line1 = line1[len(codecs.BOM_UTF8) :]

        m = PYTHON_MAGIC_COMMENT_re.match(line1)
        if not m:
            try:
                import ast

                ast.parse(line1.decode('latin-1'))
            except (ImportError, SyntaxError, UnicodeEncodeError):
                # Either it's a real syntax error, in which case the source is
                # not valid python source, or line2 is a continuation of line1,
                # in which case we don't want to scan line2 for a magic
                # comment.
                pass
            else:
                line2 = fp.readline()
                m = PYTHON_MAGIC_COMMENT_re.match(line2)

        if has_bom:
            if m:
                magic_comment_encoding = m.group(1).decode('latin-1')
                if magic_comment_encoding != 'utf-8':
                    raise SyntaxError(f"encoding problem: {magic_comment_encoding} with BOM")
            return 'utf-8'
        elif m:
            return m.group(1).decode('latin-1')
        else:
            return None
    finally:
        fp.seek(pos)


PYTHON_FUTURE_IMPORT_re = re.compile(r'from\s+__future__\s+import\s+\(*(.+)\)*')


def parse_future_flags(fp: IO[bytes], encoding: str = 'latin-1') -> int:
    """Parse the compiler flags by :mod:`__future__` from the given Python
    code.
    """
    import __future__

    pos = fp.tell()
    fp.seek(0)
    flags = 0
    try:
        body = fp.read().decode(encoding)

        # Fix up the source to be (hopefully) parsable by regexpen.
        # This will likely do untoward things if the source code itself is broken.

        # (1) Fix `import (\n...` to be `import (...`.
        body = re.sub(r'import\s*\([\r\n]+', 'import (', body)
        # (2) Join line-ending commas with the next line.
        body = re.sub(r',\s*[\r\n]+', ', ', body)
        # (3) Remove backslash line continuations.
        body = re.sub(r'\\\s*[\r\n]+', ' ', body)

        for m in PYTHON_FUTURE_IMPORT_re.finditer(body):
            names = [x.strip().strip('()') for x in m.group(1).split(',')]
            for name in names:
                feature = getattr(__future__, name, None)
                if feature:
                    flags |= feature.compiler_flag
    finally:
        fp.seek(pos)
    return flags


def pathmatch(pattern: str, filename: str) -> bool:
    """Extended pathname pattern matching.

    This function is similar to what is provided by the ``fnmatch`` module in
    the Python standard library, but:

     * can match complete (relative or absolute) path names, and not just file
       names, and
     * also supports a convenience pattern ("**") to match files at any
       directory level.

    Examples:

    >>> pathmatch('**.py', 'bar.py')
    True
    >>> pathmatch('**.py', 'foo/bar/baz.py')
    True
    >>> pathmatch('**.py', 'templates/index.html')
    False

    >>> pathmatch('./foo/**.py', 'foo/bar/baz.py')
    True
    >>> pathmatch('./foo/**.py', 'bar/baz.py')
    False

    >>> pathmatch('^foo/**.py', 'foo/bar/baz.py')
    True
    >>> pathmatch('^foo/**.py', 'bar/baz.py')
    False

    >>> pathmatch('**/templates/*.html', 'templates/index.html')
    True
    >>> pathmatch('**/templates/*.html', 'templates/foo/bar.html')
    False

    :param pattern: the glob pattern
    :param filename: the path name of the file to match against
    """
    symbols = {
        '?': '[^/]',
        '?/': '[^/]/',
        '*': '[^/]+',
        '*/': '[^/]+/',
        '**/': '(?:.+/)*?',
        '**': '(?:.+/)*?[^/]+',
    }

    if pattern.startswith('^'):
        buf = ['^']
        pattern = pattern[1:]
    elif pattern.startswith('./'):
        buf = ['^']
        pattern = pattern[2:]
    else:
        buf = []

    for idx, part in enumerate(re.split('([?*]+/?)', pattern)):
        if idx % 2:
            buf.append(symbols[part])
        elif part:
            buf.append(re.escape(part))
    match = re.match(f"{''.join(buf)}$", filename.replace(os.sep, "/"))
    return match is not None


class TextWrapper(textwrap.TextWrapper):
    wordsep_re = re.compile(
        r'(\s+|'  # any whitespace
        r'(?<=[\w\!\"\'\&\.\,\?])-{2,}(?=\w))',  # em-dash
    )

    # e.g. '\u2068foo bar.py\u2069:42'
    _enclosed_filename_re = re.compile(r'(\u2068[^\u2068]+?\u2069(?::-?\d+)?)')

    def _split(self, text):
        """Splits the text into indivisible chunks while ensuring that file names
        containing spaces are not broken up.
        """
        enclosed_filename_start = '\u2068'
        if enclosed_filename_start not in text:
            # There are no file names which contain spaces, fallback to the default implementation
            return super()._split(text)

        chunks = []
        for chunk in re.split(self._enclosed_filename_re, text):
            if chunk.startswith(enclosed_filename_start):
                chunks.append(chunk)
            else:
                chunks.extend(super()._split(chunk))
        return [c for c in chunks if c]


def wraptext(
    text: str,
    width: int = 70,
    initial_indent: str = '',
    subsequent_indent: str = '',
) -> list[str]:
    """Simple wrapper around the ``textwrap.wrap`` function in the standard
    library. This version does not wrap lines on hyphens in words. It also
    does not wrap PO file locations containing spaces.

    :param text: the text to wrap
    :param width: the maximum line width
    :param initial_indent: string that will be prepended to the first line of
                           wrapped output
    :param subsequent_indent: string that will be prepended to all lines save
                              the first of wrapped output
    """
    warnings.warn(
        "`babel.util.wraptext` is deprecated and will be removed in a future version of Babel. "
        "If you need this functionality, use the `babel.util.TextWrapper` class directly.",
        DeprecationWarning,
        stacklevel=2,
    )
    return TextWrapper(
        width=width,
        initial_indent=initial_indent,
        subsequent_indent=subsequent_indent,
        break_long_words=False,
    ).wrap(text)


# TODO (Babel 3.x): Remove this re-export
odict = dict


class FixedOffsetTimezone(datetime.tzinfo):
    """
    Fixed offset in minutes east from UTC.

    DEPRECATED: Use the standard library `datetime.timezone` instead.
    """

    # TODO (Babel 3.x): Remove this class

    def __init__(self, offset: float, name: str | None = None) -> None:
        warnings.warn(
            "`FixedOffsetTimezone` is deprecated and will be removed in a future version of Babel. "
            "Use the standard library `datetime.timezone` class.",
            DeprecationWarning,
            stacklevel=2,
        )
        self._offset = datetime.timedelta(minutes=offset)
        if name is None:
            name = 'Etc/GMT%+d' % offset
        self.zone = name

    def __str__(self) -> str:
        return self.zone

    def __repr__(self) -> str:
        return f'<FixedOffset "{self.zone}" {self._offset}>'

    def utcoffset(self, dt: datetime.datetime) -> datetime.timedelta:
        return self._offset

    def tzname(self, dt: datetime.datetime) -> str:
        return self.zone

    def dst(self, dt: datetime.datetime) -> datetime.timedelta:
        return ZERO


# Export the localtime functionality here because that's
# where it was in the past.
# TODO(3.0): remove these aliases
UTC = dates.UTC
LOCALTZ = dates.LOCALTZ
get_localzone = localtime.get_localzone
STDOFFSET = localtime.STDOFFSET
DSTOFFSET = localtime.DSTOFFSET
DSTDIFF = localtime.DSTDIFF
ZERO = localtime.ZERO


def _cmp(a: Any, b: Any):
    return (a > b) - (a < b)
