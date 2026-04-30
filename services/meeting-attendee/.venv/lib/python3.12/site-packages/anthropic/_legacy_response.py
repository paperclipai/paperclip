from __future__ import annotations

import os
import inspect
import logging
import datetime
import functools
from typing import (
    TYPE_CHECKING,
    Any,
    Union,
    Generic,
    TypeVar,
    Callable,
    Iterator,
    AsyncIterator,
    cast,
    overload,
)
from typing_extensions import Awaitable, ParamSpec, override, deprecated, get_origin

import anyio
import httpx
import pydantic

from ._types import NoneType
from ._utils import is_given, extract_type_arg, is_annotated_type, is_type_alias_type
from ._models import BaseModel, is_basemodel, add_request_id
from ._constants import RAW_RESPONSE_HEADER
from ._streaming import Stream, AsyncStream, is_stream_class_type, extract_stream_chunk_type
from ._exceptions import APIResponseValidationError
from ._decoders.jsonl import JSONLDecoder, AsyncJSONLDecoder

if TYPE_CHECKING:
    from ._models import FinalRequestOptions
    from ._base_client import BaseClient


P = ParamSpec("P")
R = TypeVar("R")
_T = TypeVar("_T")
_T_co = TypeVar("_T_co", covariant=True)

log: logging.Logger = logging.getLogger(__name__)


class LegacyAPIResponse(Generic[R]):
    """This is a legacy class as it will be replaced by `APIResponse`
    and `AsyncAPIResponse` in the `_response.py` file in the next major
    release.

    For the sync client this will mostly be the same with the exception
    of `content` & `text` will be methods instead of properties. In the
    async client, all methods will be async.

    A migration script will be provided & the migration in general should
    be smooth.
    """

    _cast_to: type[R]
    _client: BaseClient[Any, Any]
    _parsed_by_type: dict[type[Any], Any]
    _stream: bool
    _stream_cls: type[Stream[Any]] | type[AsyncStream[Any]] | None
    _options: FinalRequestOptions

    http_response: httpx.Response

    retries_taken: int
    """The number of retries made. If no retries happened this will be `0`"""

    def __init__(
        self,
        *,
        raw: httpx.Response,
        cast_to: type[R],
        client: BaseClient[Any, Any],
        stream: bool,
        stream_cls: type[Stream[Any]] | type[AsyncStream[Any]] | None,
        options: FinalRequestOptions,
        retries_taken: int = 0,
    ) -> None:
        self._cast_to = cast_to
        self._client = client
        self._parsed_by_type = {}
        self._stream = stream
        self._stream_cls = stream_cls
        self._options = options
        self.http_response = raw
        self.retries_taken = retries_taken

    @property
    def request_id(self) -> str | None:
        return self.http_response.headers.get("request-id")  # type: ignore[no-any-return]

    @overload
    def parse(self, *, to: type[_T]) -> _T: ...

    @overload
    def parse(self) -> R: ...

    def parse(self, *, to: type[_T] | None = None) -> R | _T:
        """Returns the rich python representation of this response's data.

        NOTE: For the async client: this will become a coroutine in the next major version.

        For lower-level control, see `.read()`, `.json()`, `.iter_bytes()`.

        You can customise the type that the response is parsed into through
        the `to` argument, e.g.

        ```py
        from anthropic import BaseModel


        class MyModel(BaseModel):
            foo: str


        obj = response.parse(to=MyModel)
        print(obj.foo)
        ```

        We support parsing:
          - `BaseModel`
          - `dict`
          - `list`
          - `Union`
          - `str`
          - `int`
          - `float`
          - `httpx.Response`
        """
        cache_key = to if to is not None else self._cast_to
        cached = self._parsed_by_type.get(cache_key)
        if cached is not None:
            return cached  # type: ignore[no-any-return]

        parsed = self._parse(to=to)
        if is_given(self._options.post_parser):
            parsed = self._options.post_parser(parsed)

        if isinstance(parsed, BaseModel):
            add_request_id(parsed, self.request_id)

        self._parsed_by_type[cache_key] = parsed
        return cast(R, parsed)

    @property
    def headers(self) -> httpx.Headers:
        return self.http_response.headers

    @property
    def http_request(self) -> httpx.Request:
        return self.http_response.request

    @property
    def status_code(self) -> int:
        return self.http_response.status_code

    @property
    def url(self) -> httpx.URL:
        return self.http_response.url

    @property
    def method(self) -> str:
        return self.http_request.method

    @property
    def content(self) -> bytes:
        """Return the binary response content.

        NOTE: this will be removed in favour of `.read()` in the
        next major version.
        """
        return self.http_response.content

    @property
    def text(self) -> str:
        """Return the decoded response content.

        NOTE: this will be turned into a method in the next major version.
        """
        return self.http_response.text

    @property
    def http_version(self) -> str:
        return self.http_response.http_version

    @property
    def is_closed(self) -> bool:
        return self.http_response.is_closed

    @property
    def elapsed(self) -> datetime.timedelta:
        """The time taken for the complete request/response cycle to complete."""
        return self.http_response.elapsed

    def _parse(self, *, to: type[_T] | None = None) -> R | _T:
        cast_to = to if to is not None else self._cast_to

        # unwrap `TypeAlias('Name', T)` -> `T`
        if is_type_alias_type(cast_to):
            cast_to = cast_to.__value__  # type: ignore[unreachable]

        # unwrap `Annotated[T, ...]` -> `T`
        if cast_to and is_annotated_type(cast_to):
            cast_to = extract_type_arg(cast_to, 0)

        origin = get_origin(cast_to) or cast_to

        if inspect.isclass(origin):
            if issubclass(cast(Any, origin), JSONLDecoder):
                return cast(
                    R,
                    cast("type[JSONLDecoder[Any]]", cast_to)(
                        raw_iterator=self.http_response.iter_bytes(chunk_size=64),
                        line_type=extract_type_arg(cast_to, 0),
                        http_response=self.http_response,
                    ),
                )

            if issubclass(cast(Any, origin), AsyncJSONLDecoder):
                return cast(
                    R,
                    cast("type[AsyncJSONLDecoder[Any]]", cast_to)(
                        raw_iterator=self.http_response.aiter_bytes(chunk_size=64),
                        line_type=extract_type_arg(cast_to, 0),
                        http_response=self.http_response,
                    ),
                )

        if self._stream:
            if to:
                if not is_stream_class_type(to):
                    raise TypeError(f"Expected custom parse type to be a subclass of {Stream} or {AsyncStream}")

                return cast(
                    _T,
                    to(
                        cast_to=extract_stream_chunk_type(
                            to,
                            failure_message="Expected custom stream type to be passed with a type argument, e.g. Stream[ChunkType]",
                        ),
                        response=self.http_response,
                        client=cast(Any, self._client),
                        options=self._options,
                    ),
                )

            if self._stream_cls:
                return cast(
                    R,
                    self._stream_cls(
                        cast_to=extract_stream_chunk_type(self._stream_cls),
                        response=self.http_response,
                        client=cast(Any, self._client),
                        options=self._options,
                    ),
                )

            stream_cls = cast("type[Stream[Any]] | type[AsyncStream[Any]] | None", self._client._default_stream_cls)
            if stream_cls is None:
                raise MissingStreamClassError()

            return cast(
                R,
                stream_cls(
                    cast_to=cast_to,
                    response=self.http_response,
                    client=cast(Any, self._client),
                    options=self._options,
                ),
            )

        if cast_to is NoneType:
            return cast(R, None)

        response = self.http_response
        if cast_to == str:
            return cast(R, response.text)

        if cast_to == int:
            return cast(R, int(response.text))

        if cast_to == float:
            return cast(R, float(response.text))

        if cast_to == bool:
            return cast(R, response.text.lower() == "true")

        if inspect.isclass(origin) and issubclass(origin, HttpxBinaryResponseContent):
            return cast(R, cast_to(response))  # type: ignore

        if origin == LegacyAPIResponse:
            raise RuntimeError("Unexpected state - cast_to is `APIResponse`")

        if inspect.isclass(
            origin  # pyright: ignore[reportUnknownArgumentType]
        ) and issubclass(origin, httpx.Response):
            # Because of the invariance of our ResponseT TypeVar, users can subclass httpx.Response
            # and pass that class to our request functions. We cannot change the variance to be either
            # covariant or contravariant as that makes our usage of ResponseT illegal. We could construct
            # the response class ourselves but that is something that should be supported directly in httpx
            # as it would be easy to incorrectly construct the Response object due to the multitude of arguments.
            if cast_to != httpx.Response:
                raise ValueError(f"Subclasses of httpx.Response cannot be passed to `cast_to`")
            return cast(R, response)

        if (
            inspect.isclass(
                origin  # pyright: ignore[reportUnknownArgumentType]
            )
            and not issubclass(origin, BaseModel)
            and issubclass(origin, pydantic.BaseModel)
        ):
            raise TypeError("Pydantic models must subclass our base model type, e.g. `from anthropic import BaseModel`")

        if (
            cast_to is not object
            and not origin is list
            and not origin is dict
            and not origin is Union
            and not issubclass(origin, BaseModel)
        ):
            raise RuntimeError(
                f"Unsupported type, expected {cast_to} to be a subclass of {BaseModel}, {dict}, {list}, {Union}, {NoneType}, {str} or {httpx.Response}."
            )

        # split is required to handle cases where additional information is included
        # in the response, e.g. application/json; charset=utf-8
        content_type, *_ = response.headers.get("content-type", "*").split(";")
        if not content_type.endswith("json"):
            if is_basemodel(cast_to):
                try:
                    data = response.json()
                except Exception as exc:
                    log.debug("Could not read JSON from response data due to %s - %s", type(exc), exc)
                else:
                    return self._client._process_response_data(
                        data=data,
                        cast_to=cast_to,  # type: ignore
                        response=response,
                    )

            if self._client._strict_response_validation:
                raise APIResponseValidationError(
                    response=response,
                    message=f"Expected Content-Type response header to be `application/json` but received `{content_type}` instead.",
                    body=response.text,
                )

            # If the API responds with content that isn't JSON then we just return
            # the (decoded) text without performing any parsing so that you can still
            # handle the response however you need to.
            return response.text  # type: ignore

        data = response.json()

        return self._client._process_response_data(
            data=data,
            cast_to=cast_to,  # type: ignore
            response=response,
        )

    @override
    def __repr__(self) -> str:
        return f"<APIResponse [{self.status_code} {self.http_response.reason_phrase}] type={self._cast_to}>"


class MissingStreamClassError(TypeError):
    def __init__(self) -> None:
        super().__init__(
            "The `stream` argument was set to `True` but the `stream_cls` argument was not given. See `anthropic._streaming` for reference",
        )


def to_raw_response_wrapper(func: Callable[P, R]) -> Callable[P, LegacyAPIResponse[R]]:
    """Higher order function that takes one of our bound API methods and wraps it
    to support returning the raw `APIResponse` object directly.
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> LegacyAPIResponse[R]:
        extra_headers: dict[str, str] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "true"

        kwargs["extra_headers"] = extra_headers

        return cast(LegacyAPIResponse[R], func(*args, **kwargs))

    return wrapped


def async_to_raw_response_wrapper(func: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[LegacyAPIResponse[R]]]:
    """Higher order function that takes one of our bound API methods and wraps it
    to support returning the raw `APIResponse` object directly.
    """

    @functools.wraps(func)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> LegacyAPIResponse[R]:
        extra_headers: dict[str, str] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "true"

        kwargs["extra_headers"] = extra_headers

        return cast(LegacyAPIResponse[R], await func(*args, **kwargs))

    return wrapped


class HttpxBinaryResponseContent:
    response: httpx.Response

    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    @property
    def content(self) -> bytes:
        return self.response.content

    @property
    def text(self) -> str:
        return self.response.text

    @property
    def encoding(self) -> str | None:
        return self.response.encoding

    @property
    def charset_encoding(self) -> str | None:
        return self.response.charset_encoding

    def json(self, **kwargs: Any) -> Any:
        return self.response.json(**kwargs)

    def read(self) -> bytes:
        return self.response.read()

    def iter_bytes(self, chunk_size: int | None = None) -> Iterator[bytes]:
        return self.response.iter_bytes(chunk_size)

    def iter_text(self, chunk_size: int | None = None) -> Iterator[str]:
        return self.response.iter_text(chunk_size)

    def iter_lines(self) -> Iterator[str]:
        return self.response.iter_lines()

    def iter_raw(self, chunk_size: int | None = None) -> Iterator[bytes]:
        return self.response.iter_raw(chunk_size)

    def write_to_file(
        self,
        file: str | os.PathLike[str],
    ) -> None:
        """Write the output to the given file.

        Accepts a filename or any path-like object, e.g. pathlib.Path

        Note: if you want to stream the data to the file instead of writing
        all at once then you should use `.with_streaming_response` when making
        the API request, e.g. `client.with_streaming_response.foo().stream_to_file('my_filename.txt')`
        """
        with open(file, mode="wb") as f:
            for data in self.response.iter_bytes():
                f.write(data)

    @deprecated(
        "Due to a bug, this method doesn't actually stream the response content, `.with_streaming_response.method()` should be used instead"
    )
    def stream_to_file(
        self,
        file: str | os.PathLike[str],
        *,
        chunk_size: int | None = None,
    ) -> None:
        with open(file, mode="wb") as f:
            for data in self.response.iter_bytes(chunk_size):
                f.write(data)

    def close(self) -> None:
        return self.response.close()

    async def aread(self) -> bytes:
        return await self.response.aread()

    async def aiter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        return self.response.aiter_bytes(chunk_size)

    async def aiter_text(self, chunk_size: int | None = None) -> AsyncIterator[str]:
        return self.response.aiter_text(chunk_size)

    async def aiter_lines(self) -> AsyncIterator[str]:
        return self.response.aiter_lines()

    async def aiter_raw(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        return self.response.aiter_raw(chunk_size)

    @deprecated(
        "Due to a bug, this method doesn't actually stream the response content, `.with_streaming_response.method()` should be used instead"
    )
    async def astream_to_file(
        self,
        file: str | os.PathLike[str],
        *,
        chunk_size: int | None = None,
    ) -> None:
        path = anyio.Path(file)
        async with await path.open(mode="wb") as f:
            async for data in self.response.aiter_bytes(chunk_size):
                await f.write(data)

    async def aclose(self) -> None:
        return await self.response.aclose()
