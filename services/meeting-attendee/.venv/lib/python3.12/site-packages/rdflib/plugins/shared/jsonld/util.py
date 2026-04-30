# https://github.com/RDFLib/rdflib-jsonld/blob/feature/json-ld-1.1/rdflib_jsonld/util.py
from __future__ import annotations

import json
import pathlib
from html.parser import HTMLParser
from io import StringIO, TextIOBase, TextIOWrapper
from typing import IO, TYPE_CHECKING, Any, Dict, List, Optional, TextIO, Tuple, Union

if TYPE_CHECKING:
    import json
else:
    try:
        import json

        assert json  # workaround for pyflakes issue #13
    except ImportError:
        import simplejson as json

from posixpath import normpath, sep
from typing import TYPE_CHECKING, cast
from urllib.parse import urljoin, urlsplit, urlunsplit

try:
    import orjson

    _HAS_ORJSON = True
except ImportError:
    orjson = None  # type: ignore[assignment, unused-ignore]
    _HAS_ORJSON = False


from rdflib.parser import (
    BytesIOWrapper,
    InputSource,
    PythonInputSource,
    StringInputSource,
    URLInputSource,
    create_input_source,
)


def source_to_json(
    source: Optional[
        Union[IO[bytes], TextIO, InputSource, str, bytes, pathlib.PurePath]
    ],
    fragment_id: Optional[str] = None,
    extract_all_scripts: Optional[bool] = False,
) -> Tuple[Union[Dict, List[Dict]], Any]:
    """Extract JSON from a source document.

    The source document can be JSON or HTML with embedded JSON script elements (type attribute = "application/ld+json").
    To process as HTML `source.content_type` must be set to "text/html" or "application/xhtml+xml".

    Args:
        source: the input source document (JSON or HTML)
        fragment_id: if source is an HTML document then extract only the script element with matching id attribute, defaults to None
        extract_all_scripts: if source is an HTML document then extract all script elements (unless fragment_id is provided), defaults to False (extract only the first script element)

    Returns:
        Tuple with the extracted JSON document and value of the HTML base element
    """

    if isinstance(source, PythonInputSource):
        return source.data, None

    if isinstance(source, StringInputSource):
        # A StringInputSource is assumed to be never a HTMLJSON doc
        html_base: Any = None
        # We can get the original string from the StringInputSource
        # It's hidden in the BytesIOWrapper 'wrapped' attribute
        b_stream = source.getByteStream()
        original_string: Optional[str] = None
        json_dict: Union[Dict, List[Dict]]
        if isinstance(b_stream, BytesIOWrapper):
            wrapped_inner = cast(Union[str, StringIO, TextIOBase], b_stream.wrapped)
            if isinstance(wrapped_inner, str):
                original_string = wrapped_inner
            elif isinstance(wrapped_inner, StringIO):
                original_string = wrapped_inner.getvalue()
        if _HAS_ORJSON:
            if original_string is not None:
                json_dict = orjson.loads(original_string)
            elif isinstance(b_stream, BytesIOWrapper):
                # use the CharacterStream instead
                c_stream = source.getCharacterStream()
                json_dict = orjson.loads(c_stream.read())
            else:
                # orjson assumes its in utf-8 encoding so
                # don't bother to check the source.getEncoding()
                json_dict = orjson.loads(b_stream.read())
        else:
            if original_string is not None:
                json_dict = json.loads(original_string)
            else:
                json_dict = json.load(source.getCharacterStream())
        return json_dict, html_base

    # TODO: conneg for JSON (fix support in rdflib's URLInputSource!)
    source = create_input_source(source, format="json-ld")
    try:
        content_type = source.content_type
    except (AttributeError, LookupError):
        content_type = None

    is_html = content_type is not None and content_type.lower() in (
        "text/html",
        "application/xhtml+xml",
    )
    if is_html:
        html_docparser: Optional[HTMLJSONParser] = HTMLJSONParser(
            fragment_id=fragment_id, extract_all_scripts=extract_all_scripts
        )
    else:
        html_docparser = None
    try:
        b_stream = source.getByteStream()
    except (AttributeError, LookupError):
        b_stream = None
    try:
        c_stream = source.getCharacterStream()
    except (AttributeError, LookupError):
        c_stream = None
    if b_stream is None and c_stream is None:
        raise ValueError(
            f"Source does not have a character stream or a byte stream and cannot be used {type(source)}"
        )
    try:
        b_encoding: Optional[str] = None if b_stream is None else source.getEncoding()
    except (AttributeError, LookupError):
        b_encoding = None
    underlying_string: Optional[str] = None
    if b_stream is not None and isinstance(b_stream, BytesIOWrapper):
        # Try to find an underlying wrapped Unicode string to use?
        wrapped_inner = b_stream.wrapped
        if isinstance(wrapped_inner, str):
            underlying_string = wrapped_inner
        elif isinstance(wrapped_inner, StringIO):
            underlying_string = wrapped_inner.getvalue()
    try:
        if is_html and html_docparser is not None:
            # Offload parsing to the HTMLJSONParser
            if underlying_string is not None:
                html_string: str = underlying_string
            elif c_stream is not None:
                html_string = c_stream.read()
            else:
                if TYPE_CHECKING:
                    assert b_stream is not None
                if b_encoding is None:
                    b_encoding = "utf-8"
                html_string = TextIOWrapper(b_stream, encoding=b_encoding).read()
            html_docparser.feed(html_string)
            json_dict, html_base = html_docparser.get_json(), html_docparser.get_base()
        elif _HAS_ORJSON:
            html_base = None
            if underlying_string is not None:
                json_dict = orjson.loads(underlying_string)
            elif (
                (b_stream is not None and isinstance(b_stream, BytesIOWrapper))
                or b_stream is None
            ) and c_stream is not None:
                # use the CharacterStream instead
                json_dict = orjson.loads(c_stream.read())
            else:
                if TYPE_CHECKING:
                    assert b_stream is not None
                # b_stream is not None
                json_dict = orjson.loads(b_stream.read())
        else:
            html_base = None
            if underlying_string is not None:
                return json.loads(underlying_string)
            if c_stream is not None:
                use_stream = c_stream
            else:
                if TYPE_CHECKING:
                    assert b_stream is not None
                # b_stream is not None
                if b_encoding is None:
                    b_encoding = "utf-8"
                use_stream = TextIOWrapper(b_stream, encoding=b_encoding)
            json_dict = json.load(use_stream)
        return json_dict, html_base
    finally:
        if b_stream is not None:
            try:
                b_stream.close()
            except AttributeError:
                pass
        if c_stream is not None:
            try:
                c_stream.close()
            except AttributeError:
                pass


VOCAB_DELIMS = ("#", "/", ":")


def split_iri(iri: str) -> Tuple[str, Optional[str]]:
    for delim in VOCAB_DELIMS:
        at = iri.rfind(delim)
        if at > -1:
            return iri[: at + 1], iri[at + 1 :]
    return iri, None


def norm_url(base: str, url: str) -> str:
    """
    ```python
    >>> norm_url('http://example.org/', '/one')
    'http://example.org/one'
    >>> norm_url('http://example.org/', '/one#')
    'http://example.org/one#'
    >>> norm_url('http://example.org/one', 'two')
    'http://example.org/two'
    >>> norm_url('http://example.org/one/', 'two')
    'http://example.org/one/two'
    >>> norm_url('http://example.org/', 'http://example.net/one')
    'http://example.net/one'
    >>> norm_url('http://example.org/', 'http://example.org//one')
    'http://example.org//one'

    ```
    """
    if "://" in url:
        return url

    # Fix for URNs
    parsed_base = urlsplit(base)
    parsed_url = urlsplit(url)
    if parsed_url.scheme:
        # Assume full URL
        return url
    if parsed_base.scheme in ("urn", "urn-x"):
        # No scheme -> assume relative and join paths
        base_path_parts = parsed_base.path.split("/", 1)
        base_path = "/" + (base_path_parts[1] if len(base_path_parts) > 1 else "")
        joined_path = urljoin(base_path, parsed_url.path)
        fragment = f"#{parsed_url.fragment}" if parsed_url.fragment else ""
        result = f"{parsed_base.scheme}:{base_path_parts[0]}{joined_path}{fragment}"
    else:
        parts = urlsplit(urljoin(base, url))
        path = normpath(parts[2])
        if sep != "/":
            path = "/".join(path.split(sep))
        if parts[2].endswith("/") and not path.endswith("/"):
            path += "/"
        result = urlunsplit(parts[0:2] + (path,) + parts[3:])
    if url.endswith("#") and not result.endswith("#"):
        result += "#"
    return result


# type error: Missing return statement
def context_from_urlinputsource(source: URLInputSource) -> Optional[str]:  # type: ignore[return]
    """
    Please note that JSON-LD documents served with the `application/ld+json` media type
    MUST have all context information, including references to external contexts,
    within the body of the document. Contexts linked via a
    http://www.w3.org/ns/json-ld#context HTTP Link Header MUST be
    ignored for such documents.
    """
    if source.content_type != "application/ld+json":
        try:
            # source.links is the new way of getting Link headers from URLInputSource
            links = source.links
        except AttributeError:
            # type error: Return value expected
            return  # type: ignore[return-value]
        for link in links:
            if ' rel="http://www.w3.org/ns/json-ld#context"' in link:
                i, j = link.index("<"), link.index(">")
                if i > -1 and j > -1:
                    # type error: Value of type variable "AnyStr" of "urljoin" cannot be "Optional[str]"
                    return urljoin(source.url, link[i + 1 : j])  # type: ignore[type-var]


__all__ = [
    "json",
    "source_to_json",
    "split_iri",
    "norm_url",
    "context_from_urlinputsource",
    "orjson",
    "_HAS_ORJSON",
]


class HTMLJSONParser(HTMLParser):
    def __init__(
        self,
        fragment_id: Optional[str] = None,
        extract_all_scripts: Optional[bool] = False,
    ):
        super().__init__()
        self.fragment_id = fragment_id
        self.json: List[Dict] = []
        self.contains_json = False
        self.fragment_id_does_not_match = False
        self.base = None
        self.extract_all_scripts = extract_all_scripts
        self.script_count = 0

    def handle_starttag(self, tag, attrs):
        self.contains_json = False
        self.fragment_id_does_not_match = False

        # Only set self. contains_json to True if the
        # type is 'application/ld+json'
        if tag == "script":
            for attr, value in attrs:
                if attr == "type" and value == "application/ld+json":
                    self.contains_json = True
                elif attr == "id" and self.fragment_id and value != self.fragment_id:
                    self.fragment_id_does_not_match = True

        elif tag == "base":
            for attr, value in attrs:
                if attr == "href":
                    self.base = value

    def handle_data(self, data):
        # Only do something when we know the context is a
        # script element containing application/ld+json

        if self.contains_json is True and self.fragment_id_does_not_match is False:

            if not self.extract_all_scripts and self.script_count > 0:
                return

            if data.strip() == "":
                # skip empty data elements
                return

            # Try to parse the json
            if _HAS_ORJSON:
                # orjson can load a unicode string
                # if that's the only thing we have,
                # its not worth encoding it to bytes
                parsed = orjson.loads(data)
            else:
                parsed = json.loads(data)

            # Add to the result document
            if isinstance(parsed, list):
                self.json.extend(parsed)
            else:
                self.json.append(parsed)

            self.script_count += 1

    def get_json(self) -> List[Dict]:
        return self.json

    def get_base(self):
        return self.base
