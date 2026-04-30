"""Parser plugin interface.

This module defines the parser plugin interface and contains other
related parser support code.

The module is mainly useful for those wanting to write a parser that
can plugin to rdflib. If you are wanting to invoke a parser you likely
want to do so through the Graph class parse method.
"""

from __future__ import annotations

import codecs
import os
import pathlib
import sys
from io import BufferedIOBase, BytesIO, RawIOBase, StringIO, TextIOBase, TextIOWrapper
from typing import (
    IO,
    TYPE_CHECKING,
    Any,
    BinaryIO,
    List,
    Optional,
    TextIO,
    Tuple,
    Union,
    cast,
)
from urllib.parse import urljoin
from urllib.request import Request, url2pathname
from xml.sax import xmlreader

import rdflib.util
from rdflib import __version__
from rdflib._networking import _urlopen
from rdflib.namespace import Namespace
from rdflib.term import URIRef

if TYPE_CHECKING:
    from email.message import Message
    from io import BufferedReader
    from urllib.response import addinfourl

    from typing_extensions import Buffer

    from rdflib.graph import Graph


__all__ = [
    "Parser",
    "InputSource",
    "StringInputSource",
    "URLInputSource",
    "FileInputSource",
    "PythonInputSource",
]


class Parser:
    __slots__ = ()

    def __init__(self):
        pass

    def parse(self, source: InputSource, sink: Graph) -> None:
        pass


class BytesIOWrapper(BufferedIOBase):
    __slots__ = (
        "wrapped",
        "enc_str",
        "text_str",
        "encoding",
        "encoder",
        "has_read1",
        "has_seek",
        "_name",
        "_fileno",
        "_isatty",
        "_leftover",
        "_bytes_per_char",
        "_text_bytes_offset",
    )

    def __init__(self, wrapped: Union[str, StringIO, TextIOBase], encoding="utf-8"):
        super(BytesIOWrapper, self).__init__()
        self.wrapped = wrapped
        self.encoding = encoding
        self.encoder = codecs.getencoder(self.encoding)
        self.enc_str: Optional[Union[BytesIO, BufferedIOBase]] = None
        self.text_str: Optional[Union[StringIO, TextIOBase]] = None
        self.has_read1: Optional[bool] = None
        self.has_seek: Optional[bool] = None
        self._name: Optional[str] = None
        self._fileno: Optional[Union[int, BaseException]] = None
        self._isatty: Optional[Union[bool, BaseException]] = None
        self._leftover: bytes = b""
        self._text_bytes_offset: int = 0
        norm_encoding = encoding.lower().replace("_", "-")
        if norm_encoding in ("utf-8", "utf8", "u8", "cp65001"):
            # utf-8 has a variable number of bytes per character, 1-4
            self._bytes_per_char: int = 1  # assume average of 1 byte per character
        elif norm_encoding in (
            "latin1",
            "latin-1",
            "iso-8859-1",
            "iso8859-1",
            "ascii",
            "us-ascii",
        ):
            # these are all 1-byte-per-character encodings
            self._bytes_per_char = 1
        elif norm_encoding.startswith("utf-16") or norm_encoding.startswith("utf16"):
            # utf-16 has a variable number of bytes per character, 2-3
            self._bytes_per_char = 2  # assume average of 2 bytes per character
        elif norm_encoding.startswith("utf-32") or norm_encoding.startswith("utf32"):
            # utf-32 is fixed length with 4 bytes per character
            self._bytes_per_char = 4
        else:
            # not sure, just assume it is 2 bytes per character
            self._bytes_per_char = 2

    def _init(self):
        name: Optional[str] = None
        if isinstance(self.wrapped, str):
            b, blen = self.encoder(self.wrapped)
            self.enc_str = BytesIO(b)
            name = "string"
        elif isinstance(self.wrapped, TextIOWrapper):
            inner = self.wrapped.buffer
            if isinstance(inner, BytesIOWrapper):
                raise Exception(
                    "BytesIOWrapper cannot be wrapped in TextIOWrapper, "
                    "then wrapped in another BytesIOWrapper"
                )
            else:
                self.enc_str = cast(BufferedIOBase, inner)
        elif isinstance(self.wrapped, (TextIOBase, StringIO)):
            self.text_str = self.wrapped
        use_stream: Union[BytesIO, StringIO, BufferedIOBase, TextIOBase]
        if self.enc_str is not None:
            use_stream = self.enc_str
        elif self.text_str is not None:
            use_stream = self.text_str
        else:
            raise Exception("No stream to read from")
        if name is None:
            try:
                name = use_stream.name  # type: ignore[union-attr]
            except AttributeError:
                name = "stream"
        self.has_read1 = hasattr(use_stream, "read1")
        try:
            self.has_seek = use_stream.seekable()
        except AttributeError:
            self.has_seek = hasattr(use_stream, "seek")

        self._name = name

    def _check_fileno(self):
        use_stream: Union[BytesIO, StringIO, BufferedIOBase, TextIOBase]
        if self.enc_str is None and self.text_str is None:
            self._init()
        if self.enc_str is not None:
            use_stream = self.enc_str
        elif self.text_str is not None:
            use_stream = self.text_str
        try:
            self._fileno = use_stream.fileno()
        except OSError as e:
            self._fileno = e
        except AttributeError:
            self._fileno = -1

    def _check_isatty(self):
        use_stream: Union[BytesIO, StringIO, BufferedIOBase, TextIOBase]
        if self.enc_str is None and self.text_str is None:
            self._init()
        if self.enc_str is not None:
            use_stream = self.enc_str
        elif self.text_str is not None:
            use_stream = self.text_str
        try:
            self._isatty = use_stream.isatty()
        except OSError as e:
            self._isatty = e
        except AttributeError:
            self._isatty = False

    @property
    def name(self) -> Any:
        if self._name is None:
            self._init()
        return self._name

    @property
    def closed(self) -> bool:
        if self.enc_str is None and self.text_str is None:
            return False
        closed: Optional[bool] = None
        if self.enc_str is not None:
            try:
                closed = self.enc_str.closed
            except AttributeError:
                closed = None
        elif self.text_str is not None:
            try:
                closed = self.text_str.closed
            except AttributeError:
                closed = None
        return False if closed is None else closed

    def readable(self) -> bool:
        return True

    def writable(self) -> bool:
        return False

    def truncate(self, size: Optional[int] = None) -> int:
        raise NotImplementedError("Cannot truncate on BytesIOWrapper")

    def isatty(self) -> bool:
        if self._isatty is None:
            self._check_isatty()
        if isinstance(self._isatty, BaseException):
            raise self._isatty
        else:
            return bool(self._isatty)

    def fileno(self) -> int:
        if self._fileno is None:
            self._check_fileno()
        if isinstance(self._fileno, BaseException):
            raise self._fileno
        else:
            return -1 if self._fileno is None else self._fileno

    def close(self):
        if self.enc_str is None and self.text_str is None:
            return
        if self.enc_str is not None:
            try:
                self.enc_str.close()
            except AttributeError:
                pass
        elif self.text_str is not None:
            try:
                self.text_str.close()
            except AttributeError:
                pass

    def flush(self):
        return  # Does nothing on read-only streams

    def _read_bytes_from_text_stream(self, size: Optional[int] = -1, /) -> bytes:
        if TYPE_CHECKING:
            assert self.text_str is not None
        if size is None or size < 0:
            try:
                ret_str: str = self.text_str.read()
            except EOFError:
                ret_str = ""
            ret_encoded, enc_len = self.encoder(ret_str)
            if self._leftover:
                ret_bytes = self._leftover + ret_encoded
                self._leftover = b""
            else:
                ret_bytes = ret_encoded
        elif size == len(self._leftover):
            ret_bytes = self._leftover
            self._leftover = b""
        elif size < len(self._leftover):
            ret_bytes = self._leftover[:size]
            self._leftover = self._leftover[size:]
        else:
            d, m = divmod(size, self._bytes_per_char)
            get_per_loop = int(d) + (1 if m > 0 else 0)
            got_bytes: bytes = self._leftover
            while len(got_bytes) < size:
                try:
                    got_str: str = self.text_str.read(get_per_loop)
                except EOFError:
                    got_str = ""
                if len(got_str) < 1:
                    break
                ret_encoded, enc_len = self.encoder(got_str)
                got_bytes += ret_encoded
            if len(got_bytes) == size:
                self._leftover = b""
                ret_bytes = got_bytes
            else:
                ret_bytes = got_bytes[:size]
                self._leftover = got_bytes[size:]
                del got_bytes
        self._text_bytes_offset += len(ret_bytes)
        return ret_bytes

    def read(self, size: Optional[int] = -1, /) -> bytes:
        """
        Read at most size bytes, returned as a bytes object.

        If the size argument is negative or omitted read until EOF is reached.
        Return an empty bytes object if already at EOF.
        """
        if size is not None and size == 0:
            return b""
        if self.enc_str is None and self.text_str is None:
            self._init()
        if self.enc_str is not None:
            ret_bytes = self.enc_str.read(size)
        else:
            ret_bytes = self._read_bytes_from_text_stream(size)
        return ret_bytes

    def read1(self, size: Optional[int] = -1, /) -> bytes:
        """
        Read at most size bytes, with at most one call to the underlying raw stream’s
        read() or readinto() method. Returned as a bytes object.

        If the size argument is negative or omitted, read until EOF is reached.
        Return an empty bytes object at EOF.
        """
        if (self.enc_str is None and self.text_str is None) or self.has_read1 is None:
            self._init()
        if not self.has_read1:
            raise NotImplementedError()
        if self.enc_str is not None:
            if size is None or size < 0:
                return self.enc_str.read1()
            return self.enc_str.read1(size)
        raise NotImplementedError("read1() not supported for TextIO in BytesIOWrapper")

    def readinto(self, b: Buffer, /) -> int:
        """
        Read len(b) bytes into buffer b.

        Returns number of bytes read (0 for EOF), or error if the object
        is set not to block and has no data to read.
        """
        if TYPE_CHECKING:
            assert isinstance(b, (memoryview, bytearray))
        if len(b) == 0:
            return 0
        if self.enc_str is None and self.text_str is None:
            self._init()
        if self.enc_str is not None:
            return self.enc_str.readinto(b)
        else:
            size = len(b)
            read_data: bytes = self._read_bytes_from_text_stream(size)
            read_len = len(read_data)
            if read_len == 0:
                return 0
            b[:read_len] = read_data
            return read_len

    def readinto1(self, b: Buffer, /) -> int:
        """
        Read len(b) bytes into buffer b, with at most one call to the underlying raw
        stream's read() or readinto() method.

        Returns number of bytes read (0 for EOF), or error if the object
        is set not to block and has no data to read.
        """
        if TYPE_CHECKING:
            assert isinstance(b, (memoryview, bytearray))
        if (self.enc_str is None and self.text_str is None) or self.has_read1 is None:
            self._init()
        if not self.has_read1:
            raise NotImplementedError()
        if self.enc_str is not None:
            return self.enc_str.readinto1(b)
        raise NotImplementedError(
            "readinto1() not supported for TextIO in BytesIOWrapper"
        )

    def seek(self, offset: int, whence: int = 0, /) -> int:
        if self.has_seek is not None and not self.has_seek:
            raise NotImplementedError()
        if (self.enc_str is None and self.text_str is None) or self.has_seek is None:
            self._init()

        if not whence == 0:
            raise NotImplementedError("Only SEEK_SET is supported on BytesIOWrapper")
        if offset != 0:
            raise NotImplementedError(
                "Only seeking to zero is supported on BytesIOWrapper"
            )
        if self.enc_str is not None:
            self.enc_str.seek(offset, whence)
        elif self.text_str is not None:
            self.text_str.seek(offset, whence)
        self._text_bytes_offset = 0
        self._leftover = b""
        return 0

    def seekable(self):
        if (self.enc_str is None and self.text_str is None) or self.has_seek is None:
            self._init()
        return self.has_seek

    def tell(self) -> int:
        if self.has_seek is not None and not self.has_seek:
            raise NotImplementedError("Cannot tell() pos because file is not seekable.")
        if self.enc_str is not None:
            try:
                self._text_bytes_offset = self.enc_str.tell()
            except AttributeError:
                pass
        return self._text_bytes_offset

    def write(self, b, /):
        raise NotImplementedError("Cannot write to a BytesIOWrapper")


class InputSource(xmlreader.InputSource):
    """
    TODO:
    """

    def __init__(self, system_id: Optional[str] = None):
        xmlreader.InputSource.__init__(self, system_id=system_id)
        self.content_type: Optional[str] = None
        self.auto_close = False  # see Graph.parse(), true if opened by us

    def close(self) -> None:
        c = self.getCharacterStream()
        if c and hasattr(c, "close"):
            try:
                c.close()
            except Exception:
                pass
        f = self.getByteStream()
        if f and hasattr(f, "close"):
            try:
                f.close()
            except Exception:
                pass


class PythonInputSource(InputSource):
    """
    Constructs an RDFLib Parser InputSource from a Python data structure,
    for example, loaded from JSON with json.load or json.loads:

    >>> import json
    >>> as_string = \"\"\"{
    ...   "@context" : {"ex" : "http://example.com/ns#"},
    ...   "@graph": [{"@type": "ex:item", "@id": "#example"}]
    ... }\"\"\"
    >>> as_python = json.loads(as_string)
    >>> source = create_input_source(data=as_python)
    >>> isinstance(source, PythonInputSource)
    True
    """

    def __init__(self, data: Any, system_id: Optional[str] = None):
        self.content_type = None
        self.auto_close = False  # see Graph.parse(), true if opened by us
        self.public_id: Optional[str] = None
        self.system_id: Optional[str] = system_id
        self.data = data

    def getPublicId(self) -> Optional[str]:  # noqa: N802
        return self.public_id

    def setPublicId(self, public_id: Optional[str]) -> None:  # noqa: N802
        self.public_id = public_id

    def getSystemId(self) -> Optional[str]:  # noqa: N802
        return self.system_id

    def setSystemId(self, system_id: Optional[str]) -> None:  # noqa: N802
        self.system_id = system_id

    def close(self) -> None:
        self.data = None


class StringInputSource(InputSource):
    """
    Constructs an RDFLib Parser InputSource from a Python String or Bytes
    """

    def __init__(
        self,
        value: Union[str, bytes],
        encoding: str = "utf-8",
        system_id: Optional[str] = None,
    ):
        super(StringInputSource, self).__init__(system_id)
        stream: Union[BinaryIO, TextIO]
        if isinstance(value, str):
            stream = StringIO(value)
            self.setCharacterStream(stream)
            self.setEncoding(encoding)
            b_stream = BytesIOWrapper(value, encoding)
            self.setByteStream(b_stream)
        else:
            stream = BytesIO(value)
            self.setByteStream(stream)
            c_stream = TextIOWrapper(stream, encoding)
            self.setCharacterStream(c_stream)
            self.setEncoding(c_stream.encoding)


headers = {
    "User-agent": "rdflib-%s (https://rdflib.github.io/; eikeon@eikeon.com)"
    % __version__
}


class URLInputSource(InputSource):
    """
    Constructs an RDFLib Parser InputSource from a URL to read it from the Web.
    """

    links: List[str]

    @classmethod
    def getallmatchingheaders(cls, message: Message, name) -> List[str]:
        # This is reimplemented here, because the method
        # getallmatchingheaders from HTTPMessage is broken since Python 3.0
        name = name.lower()
        return [val for key, val in message.items() if key.lower() == name]

    @classmethod
    def get_links(cls, response: addinfourl) -> List[str]:
        linkslines = cls.getallmatchingheaders(response.headers, "Link")
        retarray: List[str] = []
        for linksline in linkslines:
            links = [linkstr.strip() for linkstr in linksline.split(",")]
            for link in links:
                retarray.append(link)
        return retarray

    def get_alternates(self, type_: Optional[str] = None) -> List[str]:
        typestr: Optional[str] = f'type="{type_}"' if type_ else None
        relstr = 'rel="alternate"'
        alts = []
        for link in self.links:
            parts = [p.strip() for p in link.split(";")]
            if relstr not in parts:
                continue
            if typestr:
                if typestr in parts:
                    alts.append(parts[0].strip("<>"))
            else:
                alts.append(parts[0].strip("<>"))
        return alts

    def __init__(self, system_id: Optional[str] = None, format: Optional[str] = None):
        super(URLInputSource, self).__init__(system_id)
        self.url = system_id

        # copy headers to change
        myheaders = dict(headers)
        if format == "xml":
            myheaders["Accept"] = "application/rdf+xml, */*;q=0.1"
        elif format == "n3":
            myheaders["Accept"] = "text/n3, */*;q=0.1"
        elif format in ["turtle", "ttl"]:
            myheaders["Accept"] = "text/turtle, application/x-turtle, */*;q=0.1"
        elif format == "nt":
            myheaders["Accept"] = "text/plain, */*;q=0.1"
        elif format == "trig":
            myheaders["Accept"] = "application/trig, */*;q=0.1"
        elif format == "trix":
            myheaders["Accept"] = "application/trix, */*;q=0.1"
        elif format == "json-ld":
            myheaders["Accept"] = (
                "application/ld+json, application/json;q=0.9, */*;q=0.1"
            )
        else:
            # if format not given, create an Accept header from all registered
            # parser Media Types
            from rdflib.parser import Parser
            from rdflib.plugin import plugins

            acc = []
            for p in plugins(kind=Parser):  # only get parsers
                if "/" in p.name:  # all Media Types known have a / in them
                    acc.append(p.name)

            myheaders["Accept"] = ", ".join(acc)

        req = Request(system_id, None, myheaders)  # type: ignore[arg-type]

        response: addinfourl = _urlopen(req)
        self.url = response.geturl()  # in case redirections took place
        self.links = self.get_links(response)
        if format in ("json-ld", "application/ld+json"):
            alts = self.get_alternates(type_="application/ld+json")
            for link in alts:
                full_link = urljoin(self.url, link)
                if full_link != self.url and full_link != system_id:
                    response = _urlopen(Request(full_link))
                    self.url = response.geturl()  # in case redirections took place
                    break

        self.setPublicId(self.url)
        content_types = self.getallmatchingheaders(response.headers, "content-type")
        self.content_type = content_types[0] if content_types else None
        if self.content_type is not None:
            self.content_type = self.content_type.split(";", 1)[0]
        self.setByteStream(response)
        # TODO: self.setEncoding(encoding)
        self.response_info = response.info()  # a mimetools.Message instance

    def __repr__(self) -> str:
        # type error: Incompatible return value type (got "Optional[str]", expected "str")
        return self.url  # type: ignore[return-value]


class FileInputSource(InputSource):
    def __init__(
        self,
        file: Union[BinaryIO, TextIO, TextIOBase, RawIOBase, BufferedIOBase],
        /,
        encoding: Optional[str] = None,
    ):
        base = pathlib.Path.cwd().as_uri()
        system_id = URIRef(pathlib.Path(file.name).absolute().as_uri(), base=base)  # type: ignore[union-attr]
        super(FileInputSource, self).__init__(system_id)
        self.file = file
        if isinstance(file, TextIOBase):  # Python3 unicode fp
            self.setCharacterStream(file)
            self.setEncoding(file.encoding)
            try:
                b = file.buffer  # type: ignore[attr-defined]
                self.setByteStream(b)
            except (AttributeError, LookupError):
                self.setByteStream(BytesIOWrapper(file, encoding=file.encoding))
        else:
            if TYPE_CHECKING:
                assert isinstance(file, BufferedReader)
            self.setByteStream(file)
            if encoding is not None:
                self.setEncoding(encoding)
                self.setCharacterStream(TextIOWrapper(file, encoding=encoding))
            else:
                # We cannot set characterStream here because
                # we do not know the Raw Bytes File encoding.
                pass

    def __repr__(self) -> str:
        return repr(self.file)


def create_input_source(
    source: Optional[
        Union[IO[bytes], TextIO, InputSource, str, bytes, pathlib.PurePath]
    ] = None,
    publicID: Optional[str] = None,  # noqa: N803
    location: Optional[str] = None,
    file: Optional[Union[BinaryIO, TextIO]] = None,
    data: Optional[Union[str, bytes, dict]] = None,
    format: Optional[str] = None,
) -> InputSource:
    """
    Return an appropriate InputSource instance for the given
    parameters.
    """

    # test that exactly one of source, location, file, and data is not None.
    non_empty_arguments = list(
        filter(
            lambda v: v is not None,
            [source, location, file, data],
        )
    )

    if len(non_empty_arguments) != 1:
        raise ValueError(
            "exactly one of source, location, file or data must be given",
        )

    input_source = None

    if source is not None:
        if TYPE_CHECKING:
            assert file is None
            assert data is None
            assert location is None
        if isinstance(source, InputSource):
            input_source = source
        else:
            if isinstance(source, str):
                location = source
            elif isinstance(source, pathlib.PurePath):
                location = str(source)
            elif isinstance(source, bytes):
                data = source
            elif hasattr(source, "read") and not isinstance(source, Namespace):
                f = source
                input_source = InputSource()
                if hasattr(source, "encoding"):
                    input_source.setCharacterStream(source)
                    input_source.setEncoding(source.encoding)
                    try:
                        b = source.buffer  # type: ignore[union-attr]
                        input_source.setByteStream(b)
                    except (AttributeError, LookupError):
                        input_source.setByteStream(source)
                else:
                    input_source.setByteStream(f)
                if f is sys.stdin:
                    input_source.setSystemId("file:///dev/stdin")
                elif hasattr(f, "name"):
                    input_source.setSystemId(f.name)
            else:
                raise Exception(
                    "Unexpected type '%s' for source '%s'" % (type(source), source)
                )

    absolute_location = None  # Further to fix for issue 130

    auto_close = False  # make sure we close all file handles we open

    if location is not None:
        if TYPE_CHECKING:
            assert file is None
            assert data is None
            assert source is None
        (
            absolute_location,
            auto_close,
            file,
            input_source,
        ) = _create_input_source_from_location(
            file=file,
            format=format,
            input_source=input_source,
            location=location,
        )

    if file is not None:
        if TYPE_CHECKING:
            assert location is None
            assert data is None
            assert source is None
        input_source = FileInputSource(file)

    if data is not None:
        if TYPE_CHECKING:
            assert location is None
            assert file is None
            assert source is None
        if isinstance(data, dict):
            input_source = PythonInputSource(data)
            auto_close = True
        elif isinstance(data, (str, bytes, bytearray)):
            input_source = StringInputSource(data)
            auto_close = True
        else:
            raise RuntimeError(f"parse data can only str, or bytes. not: {type(data)}")

    if input_source is None:
        raise Exception("could not create InputSource")
    else:
        input_source.auto_close |= auto_close
        if publicID is not None:  # Further to fix for issue 130
            input_source.setPublicId(publicID)
        # Further to fix for issue 130
        elif input_source.getPublicId() is None:
            input_source.setPublicId(absolute_location or "")
        return input_source


def _create_input_source_from_location(
    file: Optional[Union[BinaryIO, TextIO]],
    format: Optional[str],
    input_source: Optional[InputSource],
    location: str,
) -> Tuple[URIRef, bool, Optional[Union[BinaryIO, TextIO]], Optional[InputSource]]:
    # Fix for Windows problem https://github.com/RDFLib/rdflib/issues/145 and
    # https://github.com/RDFLib/rdflib/issues/1430
    # NOTE: using pathlib.Path.exists on a URL fails on windows as it is not a
    # valid path. However os.path.exists() returns false for a URL on windows
    # which is why it is being used instead.
    if os.path.exists(location):
        location = pathlib.Path(location).absolute().as_uri()

    base = pathlib.Path.cwd().as_uri()

    absolute_location = URIRef(rdflib.util._iri2uri(location), base=base)

    if absolute_location.startswith("file:///"):
        filename = url2pathname(absolute_location.replace("file:///", "/"))
        file = open(filename, "rb")
    else:
        input_source = URLInputSource(absolute_location, format)

    auto_close = True
    # publicID = publicID or absolute_location  # Further to fix
    # for issue 130

    return absolute_location, auto_close, file, input_source
