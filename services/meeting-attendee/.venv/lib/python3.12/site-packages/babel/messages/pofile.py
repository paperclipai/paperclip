"""
babel.messages.pofile
~~~~~~~~~~~~~~~~~~~~~

Reading and writing of files in the ``gettext`` PO (portable object)
format.

:copyright: (c) 2013-2026 by the Babel Team.
:license: BSD, see LICENSE for more details.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from typing import TYPE_CHECKING, Literal

from babel.core import Locale
from babel.messages.catalog import Catalog, Message
from babel.util import TextWrapper

if TYPE_CHECKING:
    from typing import IO, AnyStr

    from _typeshed import SupportsWrite


_unescape_re = re.compile(r'\\([\\trn"])')


def unescape(string: str) -> str:
    r"""Reverse `escape` the given string.

    >>> print(unescape('"Say:\\n  \\"hello, world!\\"\\n"'))
    Say:
      "hello, world!"
    <BLANKLINE>

    :param string: the string to unescape
    """

    def replace_escapes(match):
        m = match.group(1)
        if m == 'n':
            return '\n'
        elif m == 't':
            return '\t'
        elif m == 'r':
            return '\r'
        # m is \ or "
        return m

    if "\\" not in string:  # Fast path: there's nothing to unescape
        return string[1:-1]
    return _unescape_re.sub(replace_escapes, string[1:-1])


def denormalize(string: str) -> str:
    r"""Reverse the normalization done by the `normalize` function.

    >>> print(denormalize(r'''""
    ... "Say:\n"
    ... "  \"hello, world!\"\n"'''))
    Say:
      "hello, world!"
    <BLANKLINE>

    >>> print(denormalize(r'''""
    ... "Say:\n"
    ... "  \"Lorem ipsum dolor sit "
    ... "amet, consectetur adipisicing"
    ... " elit, \"\n"'''))
    Say:
      "Lorem ipsum dolor sit amet, consectetur adipisicing elit, "
    <BLANKLINE>

    :param string: the string to denormalize
    """
    if '\n' in string:
        escaped_lines = string.splitlines()
        if string.startswith('""'):
            escaped_lines = escaped_lines[1:]
        return ''.join(map(unescape, escaped_lines))
    else:
        return unescape(string)


def _extract_locations(line: str) -> list[str]:
    """Extract locations from location comments.

    Locations are extracted while properly handling First Strong
    Isolate (U+2068) and Pop Directional Isolate (U+2069), used by
    gettext to enclose filenames with spaces and tabs in their names.
    """
    if "\u2068" not in line and "\u2069" not in line:
        return line.lstrip().split()

    locations = []
    location = ""
    in_filename = False
    for c in line:
        if c == "\u2068":
            if in_filename:
                raise ValueError(
                    "location comment contains more First Strong Isolate "
                    "characters, than Pop Directional Isolate characters",
                )
            in_filename = True
            continue
        elif c == "\u2069":
            if not in_filename:
                raise ValueError(
                    "location comment contains more Pop Directional Isolate "
                    "characters, than First Strong Isolate characters",
                )
            in_filename = False
            continue
        elif c == " ":
            if in_filename:
                location += c
            elif location:
                locations.append(location)
                location = ""
        else:
            location += c
    else:
        if location:
            if in_filename:
                raise ValueError(
                    "location comment contains more First Strong Isolate "
                    "characters, than Pop Directional Isolate characters",
                )
            locations.append(location)

    return locations


class PoFileError(Exception):
    """Exception thrown by PoParser when an invalid po file is encountered."""

    def __init__(self, message: str, catalog: Catalog, line: str, lineno: int) -> None:
        super().__init__(f'{message} on {lineno}')
        self.catalog = catalog
        self.line = line
        self.lineno = lineno


class _NormalizedString(list):
    def __init__(self, *args: str) -> None:
        super().__init__(map(str.strip, args))

    def denormalize(self) -> str:
        if not self:
            return ""
        return ''.join(map(unescape, self))


class PoFileParser:
    """Support class to  read messages from a ``gettext`` PO (portable object) file
    and add them to a `Catalog`

    See `read_po` for simple cases.
    """

    def __init__(
        self,
        catalog: Catalog,
        ignore_obsolete: bool = False,
        abort_invalid: bool = False,
    ) -> None:
        self.catalog = catalog
        self.ignore_obsolete = ignore_obsolete
        self.counter = 0
        self.offset = 0
        self.abort_invalid = abort_invalid
        self._reset_message_state()

    def _reset_message_state(self) -> None:
        self.messages = []
        self.translations = []
        self.locations = []
        self.flags = []
        self.user_comments = []
        self.auto_comments = []
        self.context = None
        self.obsolete = False
        self.in_msgid = False
        self.in_msgstr = False
        self.in_msgctxt = False

    def _add_message(self) -> None:
        """
        Add a message to the catalog based on the current parser state and
        clear the state ready to process the next message.
        """
        if len(self.messages) > 1:
            msgid = tuple(m.denormalize() for m in self.messages)
            string = ['' for _ in range(self.catalog.num_plurals)]
            for idx, translation in sorted(self.translations):
                if idx >= self.catalog.num_plurals:
                    self._invalid_pofile(
                        "",
                        self.offset,
                        "msg has more translations than num_plurals of catalog",
                    )
                    continue
                string[idx] = translation.denormalize()
            string = tuple(string)
        else:
            msgid = self.messages[0].denormalize()
            string = self.translations[0][1].denormalize()
        msgctxt = self.context.denormalize() if self.context else None
        message = Message(
            msgid,
            string,
            self.locations,
            self.flags,
            self.auto_comments,
            self.user_comments,
            lineno=self.offset + 1,
            context=msgctxt,
        )
        if self.obsolete:
            if not self.ignore_obsolete:
                self.catalog.obsolete[self.catalog._key_for(msgid, msgctxt)] = message
        else:
            self.catalog[msgid] = message
        self.counter += 1
        self._reset_message_state()

    def _finish_current_message(self) -> None:
        if self.messages:
            if not self.translations:
                self._invalid_pofile(
                    "",
                    self.offset,
                    f"missing msgstr for msgid '{self.messages[0].denormalize()}'",
                )
                self.translations.append([0, _NormalizedString()])
            self._add_message()

    def _process_message_line(self, lineno, line, obsolete=False) -> None:
        if not line:
            return
        if line[0] == '"':
            self._process_string_continuation_line(line, lineno)
        else:
            self._process_keyword_line(lineno, line, obsolete)

    def _process_keyword_line(self, lineno, line, obsolete=False) -> None:
        keyword, _, arg = line.partition(' ')

        if keyword in ['msgid', 'msgctxt']:
            self._finish_current_message()

        self.obsolete = obsolete

        # The line that has the msgid is stored as the offset of the msg
        # should this be the msgctxt if it has one?
        if keyword == 'msgid':
            self.offset = lineno

        if keyword in ['msgid', 'msgid_plural']:
            self.in_msgctxt = False
            self.in_msgid = True
            self.messages.append(_NormalizedString(arg))
            return

        if keyword == 'msgctxt':
            self.in_msgctxt = True
            self.context = _NormalizedString(arg)
            return

        if keyword == 'msgstr' or keyword.startswith('msgstr['):
            self.in_msgid = False
            self.in_msgstr = True
            kwarg, has_bracket, idxarg = keyword.partition('[')
            idx = int(idxarg[:-1]) if has_bracket else 0
            s = _NormalizedString(arg) if arg != '""' else _NormalizedString()
            self.translations.append([idx, s])
            return

        self._invalid_pofile(line, lineno, "Unknown or misformatted keyword")

    def _process_string_continuation_line(self, line, lineno) -> None:
        if self.in_msgid:
            s = self.messages[-1]
        elif self.in_msgstr:
            s = self.translations[-1][1]
        elif self.in_msgctxt:
            s = self.context
        else:
            self._invalid_pofile(
                line,
                lineno,
                "Got line starting with \" but not in msgid, msgstr or msgctxt",
            )
            return
        # For performance reasons, `NormalizedString` doesn't strip internally
        s.append(line.strip())

    def _process_comment(self, line) -> None:
        self._finish_current_message()

        prefix = line[:2]
        if prefix == '#:':
            for location in _extract_locations(line[2:]):
                a, colon, b = location.rpartition(':')
                if colon:
                    try:
                        self.locations.append((a, int(b)))
                    except ValueError:
                        continue
                else:  # No line number specified
                    self.locations.append((location, None))
            return

        if prefix == '#,':
            self.flags.extend(flag.strip() for flag in line[2:].lstrip().split(','))
            return

        if prefix == '#.':
            # These are called auto-comments
            comment = line[2:].strip()
            if comment:  # Just check that we're not adding empty comments
                self.auto_comments.append(comment)
            return

        # These are called user comments
        self.user_comments.append(line[1:].strip())

    def parse(self, fileobj: IO[AnyStr] | Iterable[AnyStr]) -> None:
        """
        Reads from the file-like object (or iterable of string-likes) `fileobj`
        and adds any po file units found in it to the `Catalog`
        supplied to the constructor.

        All of the items in the iterable must be the same type; either `str`
        or `bytes` (decoded with the catalog charset), but not a mixture.
        """
        needs_decode = None

        for lineno, line in enumerate(fileobj):
            line = line.strip()
            if needs_decode is None:
                # If we don't yet know whether we need to decode,
                # let's find out now.
                needs_decode = not isinstance(line, str)
            if not line:
                continue
            if needs_decode:
                line = line.decode(self.catalog.charset)
            if line[0] == '#':
                if line[:2] == '#~':
                    self._process_message_line(lineno, line[2:].lstrip(), obsolete=True)
                else:
                    try:
                        self._process_comment(line)
                    except ValueError as exc:
                        self._invalid_pofile(line, lineno, str(exc))
            else:
                self._process_message_line(lineno, line)

        self._finish_current_message()

        # No actual messages found, but there was some info in comments, from which
        # we'll construct an empty header message
        if not self.counter and (self.flags or self.user_comments or self.auto_comments):
            self.messages.append(_NormalizedString())
            self.translations.append([0, _NormalizedString()])
            self._add_message()

    def _invalid_pofile(self, line, lineno, msg) -> None:
        assert isinstance(line, str)
        if self.abort_invalid:
            raise PoFileError(msg, self.catalog, line, lineno)
        print("WARNING:", msg)
        print(f"WARNING: Problem on line {lineno + 1}: {line!r}")


def read_po(
    fileobj: IO[AnyStr] | Iterable[AnyStr],
    locale: Locale | str | None = None,
    domain: str | None = None,
    ignore_obsolete: bool = False,
    charset: str | None = None,
    abort_invalid: bool = False,
) -> Catalog:
    """Read messages from a ``gettext`` PO (portable object) file from the given
    file-like object (or an iterable of lines) and return a `Catalog`.

    >>> from datetime import datetime
    >>> from io import StringIO
    >>> buf = StringIO('''
    ... #: main.py:1
    ... #, fuzzy, python-format
    ... msgid "foo %(name)s"
    ... msgstr "quux %(name)s"
    ...
    ... # A user comment
    ... #. An auto comment
    ... #: main.py:3
    ... msgid "bar"
    ... msgid_plural "baz"
    ... msgstr[0] "bar"
    ... msgstr[1] "baaz"
    ... ''')
    >>> catalog = read_po(buf)
    >>> catalog.revision_date = datetime(2007, 4, 1)

    >>> for message in catalog:
    ...     if message.id:
    ...         print((message.id, message.string))
    ...         print(' ', (message.locations, sorted(list(message.flags))))
    ...         print(' ', (message.user_comments, message.auto_comments))
    ('foo %(name)s', 'quux %(name)s')
      ([('main.py', 1)], ['fuzzy', 'python-format'])
      ([], [])
    (('bar', 'baz'), ('bar', 'baaz'))
      ([('main.py', 3)], [])
      (['A user comment'], ['An auto comment'])

    .. versionadded:: 1.0
       Added support for explicit charset argument.

    :param fileobj: the file-like object (or iterable of lines) to read the PO file from
    :param locale: the locale identifier or `Locale` object, or `None`
                   if the catalog is not bound to a locale (which basically
                   means it's a template)
    :param domain: the message domain
    :param ignore_obsolete: whether to ignore obsolete messages in the input
    :param charset: the character set of the catalog.
    :param abort_invalid: abort read if po file is invalid
    """
    catalog = Catalog(locale=locale, domain=domain, charset=charset)
    parser = PoFileParser(catalog, ignore_obsolete, abort_invalid=abort_invalid)
    parser.parse(fileobj)
    return catalog


WORD_SEP = re.compile(
    '('
    r'\s+|'  # any whitespace
    r'[^\s\w]*\w+[a-zA-Z]-(?=\w+[a-zA-Z])|'  # hyphenated words
    r'(?<=[\w\!\"\'\&\.\,\?])-{2,}(?=\w)'  # em-dash
    ')',
)


def escape(string: str) -> str:
    r"""Escape the given string so that it can be included in double-quoted
    strings in ``PO`` files.

    >>> escape('''Say:
    ...   "hello, world!"
    ... ''')
    '"Say:\\n  \\"hello, world!\\"\\n"'

    :param string: the string to escape
    """
    return '"%s"' % string.replace('\\', '\\\\').replace('\t', '\\t').replace(
        '\r',
        '\\r',
    ).replace('\n', '\\n').replace('"', '\\"')


def normalize(string: str, prefix: str = '', width: int = 76) -> str:
    r"""Convert a string into a format that is appropriate for .po files.

    >>> print(normalize('''Say:
    ...   "hello, world!"
    ... ''', width=None))
    ""
    "Say:\n"
    "  \"hello, world!\"\n"

    >>> print(normalize('''Say:
    ...   "Lorem ipsum dolor sit amet, consectetur adipisicing elit, "
    ... ''', width=32))
    ""
    "Say:\n"
    "  \"Lorem ipsum dolor sit "
    "amet, consectetur adipisicing"
    " elit, \"\n"

    :param string: the string to normalize
    :param prefix: a string that should be prepended to every line
    :param width: the maximum line width; use `None`, 0, or a negative number
                  to completely disable line wrapping
    """
    if width and width > 0:
        prefixlen = len(prefix)
        lines = []
        for line in string.splitlines(True):
            if len(escape(line)) + prefixlen > width:
                chunks = WORD_SEP.split(line)
                chunks.reverse()
                while chunks:
                    buf = []
                    size = 2
                    while chunks:
                        length = len(escape(chunks[-1])) - 2 + prefixlen
                        if size + length < width:
                            buf.append(chunks.pop())
                            size += length
                        else:
                            if not buf:
                                # handle long chunks by putting them on a
                                # separate line
                                buf.append(chunks.pop())
                            break
                    lines.append(''.join(buf))
            else:
                lines.append(line)
    else:
        lines = string.splitlines(True)

    if len(lines) <= 1:
        return escape(string)

    # Remove empty trailing line
    if lines and not lines[-1]:
        del lines[-1]
        lines[-1] += '\n'
    return '""\n' + '\n'.join([(prefix + escape(line)) for line in lines])


def _enclose_filename_if_necessary(filename: str) -> str:
    """Enclose filenames which include white spaces or tabs.

    Do the same as gettext and enclose filenames which contain white
    spaces or tabs with First Strong Isolate (U+2068) and Pop
    Directional Isolate (U+2069).
    """
    if " " not in filename and "\t" not in filename:
        return filename

    if not filename.startswith("\u2068"):
        filename = "\u2068" + filename
    if not filename.endswith("\u2069"):
        filename += "\u2069"
    return filename


def write_po(
    fileobj: SupportsWrite[bytes],
    catalog: Catalog,
    width: int = 76,
    no_location: bool = False,
    omit_header: bool = False,
    sort_output: bool = False,
    sort_by_file: bool = False,
    ignore_obsolete: bool = False,
    include_previous: bool = False,
    include_lineno: bool = True,
) -> None:
    r"""Write a ``gettext`` PO (portable object) template file for a given
    message catalog to the provided file-like object.

    >>> catalog = Catalog()
    >>> catalog.add('foo %(name)s', locations=[('main.py', 1)],
    ...             flags=('fuzzy',))
    <Message...>
    >>> catalog.add(('bar', 'baz'), locations=[('main.py', 3)])
    <Message...>
    >>> from io import BytesIO
    >>> buf = BytesIO()
    >>> write_po(buf, catalog, omit_header=True)
    >>> print(buf.getvalue().decode("utf8"))
    #: main.py:1
    #, fuzzy, python-format
    msgid "foo %(name)s"
    msgstr ""
    <BLANKLINE>
    #: main.py:3
    msgid "bar"
    msgid_plural "baz"
    msgstr[0] ""
    msgstr[1] ""
    <BLANKLINE>
    <BLANKLINE>

    :param fileobj: the file-like object to write to
    :param catalog: the `Catalog` instance
    :param width: the maximum line width for the generated output; use `None`,
                  0, or a negative number to completely disable line wrapping
    :param no_location: do not emit a location comment for every message
    :param omit_header: do not include the ``msgid ""`` entry at the top of the
                        output
    :param sort_output: whether to sort the messages in the output by msgid
    :param sort_by_file: whether to sort the messages in the output by their
                         locations
    :param ignore_obsolete: whether to ignore obsolete messages and not include
                            them in the output; by default they are included as
                            comments
    :param include_previous: include the old msgid as a comment when
                             updating the catalog
    :param include_lineno: include line number in the location comment
    """

    sort_by = None
    if sort_output:
        sort_by = "message"
    elif sort_by_file:
        sort_by = "location"

    for line in generate_po(
        catalog,
        ignore_obsolete=ignore_obsolete,
        include_lineno=include_lineno,
        include_previous=include_previous,
        no_location=no_location,
        omit_header=omit_header,
        sort_by=sort_by,
        width=width,
    ):
        if isinstance(line, str):
            line = line.encode(catalog.charset, 'backslashreplace')
        fileobj.write(line)


def generate_po(
    catalog: Catalog,
    *,
    ignore_obsolete: bool = False,
    include_lineno: bool = True,
    include_previous: bool = False,
    no_location: bool = False,
    omit_header: bool = False,
    sort_by: Literal["message", "location"] | None = None,
    width: int = 76,
) -> Iterable[str]:
    r"""Yield text strings representing a ``gettext`` PO (portable object) file.

    See `write_po()` for a more detailed description.
    """
    # xgettext always wraps comments even if --no-wrap is passed;
    # provide the same behaviour
    comment_width = width if width and width > 0 else 76

    comment_wrapper = TextWrapper(width=comment_width, break_long_words=False)
    header_wrapper = TextWrapper(width=width, subsequent_indent="# ", break_long_words=False)

    def _format_comment(comment, prefix=''):
        for line in comment_wrapper.wrap(comment):
            yield f"#{prefix} {line.strip()}\n"

    def _format_message(message, prefix=''):
        if isinstance(message.id, (list, tuple)):
            if message.context:
                yield f"{prefix}msgctxt {normalize(message.context, prefix=prefix, width=width)}\n"
            yield f"{prefix}msgid {normalize(message.id[0], prefix=prefix, width=width)}\n"
            yield f"{prefix}msgid_plural {normalize(message.id[1], prefix=prefix, width=width)}\n"

            for idx in range(catalog.num_plurals):
                try:
                    string = message.string[idx]
                except IndexError:
                    string = ''
                yield f"{prefix}msgstr[{idx:d}] {normalize(string, prefix=prefix, width=width)}\n"
        else:
            if message.context:
                yield f"{prefix}msgctxt {normalize(message.context, prefix=prefix, width=width)}\n"
            yield f"{prefix}msgid {normalize(message.id, prefix=prefix, width=width)}\n"
            yield f"{prefix}msgstr {normalize(message.string or '', prefix=prefix, width=width)}\n"

    for message in _sort_messages(catalog, sort_by=sort_by):
        if not message.id:  # This is the header "message"
            if omit_header:
                continue
            comment_header = catalog.header_comment
            if width and width > 0:
                lines = []
                for line in comment_header.splitlines():
                    lines += header_wrapper.wrap(line)
                comment_header = '\n'.join(lines)
            yield f"{comment_header}\n"

        for comment in message.user_comments:
            yield from _format_comment(comment)
        for comment in message.auto_comments:
            yield from _format_comment(comment, prefix='.')

        if not no_location:
            locs = []

            # sort locations by filename and lineno.
            # if there's no <int> as lineno, use `-1`.
            # if no sorting possible, leave unsorted.
            # (see issue #606)
            try:
                locations = sorted(
                    message.locations,
                    key=lambda x: (x[0], isinstance(x[1], int) and x[1] or -1),
                )
            except TypeError:  # e.g. "TypeError: unorderable types: NoneType() < int()"
                locations = message.locations

            for filename, lineno in locations:
                location = filename.replace(os.sep, '/')
                location = _enclose_filename_if_necessary(location)
                if lineno and include_lineno:
                    location = f"{location}:{lineno:d}"
                if location not in locs:
                    locs.append(location)
            yield from _format_comment(' '.join(locs), prefix=':')
        if message.flags:
            yield f"#{', '.join(['', *sorted(message.flags)])}\n"

        if message.previous_id and include_previous:
            yield from _format_comment(
                f'msgid {normalize(message.previous_id[0], width=width)}',
                prefix='|',
            )
            if len(message.previous_id) > 1:
                norm_previous_id = normalize(message.previous_id[1], width=width)
                yield from _format_comment(f'msgid_plural {norm_previous_id}', prefix='|')

        yield from _format_message(message)
        yield '\n'

    if not ignore_obsolete:
        for message in _sort_messages(
            catalog.obsolete.values(),
            sort_by=sort_by,
        ):
            for comment in message.user_comments:
                yield from _format_comment(comment)
            yield from _format_message(message, prefix='#~ ')
            yield '\n'


def _sort_messages(
    messages: Iterable[Message],
    sort_by: Literal["message", "location"] | None,
) -> list[Message]:
    """
    Sort the given message iterable by the given criteria.

    Always returns a list.

    :param messages: An iterable of Messages.
    :param sort_by: Sort by which criteria? Options are `message` and `location`.
    :return: list[Message]
    """
    messages = list(messages)
    if sort_by == "message":
        messages.sort()
    elif sort_by == "location":
        messages.sort(key=lambda m: m.locations)
    return messages
