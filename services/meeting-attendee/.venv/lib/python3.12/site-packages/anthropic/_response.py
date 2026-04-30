from __future__ import annotations

import os
import inspect
import logging
import datetime
import functools
from types import TracebackType
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
from typing_extensions import Awaitable, ParamSpec, override, get_origin

import anyio
import httpx
import pydantic

from ._types import NoneType
from ._utils import is_given, extract_type_arg, is_annotated_type, is_type_alias_type, extract_type_var_from_base
from ._models import BaseModel, is_basemodel, add_request_id
from ._constants import RAW_RESPONSE_HEADER, OVERRIDE_CAST_TO_HEADER
from ._streaming import Stream, AsyncStream, is_stream_class_type, extract_stream_chunk_type
from ._exceptions import AnthropicError, APIResponseValidationError
from ._decoders.jsonl import JSONLDecoder, AsyncJSONLDecoder

if TYPE_CHECKING:
    from ._models import FinalRequestOptions
    from ._base_client import BaseClient


P = ParamSpec("P")
R = TypeVar("R")
_T = TypeVar("_T")
_APIResponseT = TypeVar("_APIResponseT", bound="APIResponse[Any]")
_AsyncAPIResponseT = TypeVar("_AsyncAPIResponseT", bound="AsyncAPIResponse[Any]")

log: logging.Logger = logging.getLogger(__name__)


class BaseAPIResponse(Generic[R]):
    _cast_to: type[R]
    _client: BaseClient[Any, Any]
    _parsed_by_type: dict[type[Any], Any]
    _is_sse_stream: bool
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
        self._is_sse_stream = stream
        self._stream_cls = stream_cls
        self._options = options
        self.http_response = raw
        self.retries_taken = retries_taken

    @property
    def headers(self) -> httpx.Headers:
        return self.http_response.headers

    @property
    def http_request(self) -> httpx.Request:
        """Returns the httpx Request instance associated with the current response."""
        return self.http_response.request

    @property
    def status_code(self) -> int:
        return self.http_response.status_code

    @property
    def url(self) -> httpx.URL:
        """Returns the URL for which the request was made."""
        return self.http_response.url

    @property
    def method(self) -> str:
        return self.http_request.method

    @property
    def http_version(self) -> str:
        return self.http_response.http_version

    @property
    def elapsed(self) -> datetime.timedelta:
        """The time taken for the complete request/response cycle to complete."""
        return self.http_response.elapsed

    @property
    def is_closed(self) -> bool:
        """Whether or not the response body has been closed.

        If this is False then there is response data that has not been read yet.
        You must either fully consume the response body or call `.close()`
        before discarding the response to prevent resource leaks.
        """
        return self.http_response.is_closed

    @override
    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} [{self.status_code} {self.http_response.reason_phrase}] type={self._cast_to}>"
        )

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

        if self._is_sse_stream:
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

        if cast_to == bytes:
            return cast(R, response.content)

        if cast_to == int:
            return cast(R, int(response.text))

        if cast_to == float:
            return cast(R, float(response.text))

        if cast_to == bool:
            return cast(R, response.text.lower() == "true")

        # handle the legacy binary response case
        if inspect.isclass(cast_to) and cast_to.__name__ == "HttpxBinaryResponseContent":
            return cast(R, cast_to(response))  # type: ignore

        if origin == APIResponse:
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


class APIResponse(BaseAPIResponse[R]):
    @property
    def request_id(self) -> str | None:
        return self.http_response.headers.get("request-id")  # type: ignore[no-any-return]

    @overload
    def parse(self, *, to: type[_T]) -> _T: ...

    @overload
    def parse(self) -> R: ...

    def parse(self, *, to: type[_T] | None = None) -> R | _T:
        """Returns the rich python representation of this response's data.

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

        if not self._is_sse_stream:
            self.read()

        parsed = self._parse(to=to)
        if is_given(self._options.post_parser):
            parsed = self._options.post_parser(parsed)

        if isinstance(parsed, BaseModel):
            add_request_id(parsed, self.request_id)

        self._parsed_by_type[cache_key] = parsed
        return cast(R, parsed)

    def read(self) -> bytes:
        """Read and return the binary response content."""
        try:
            return self.http_response.read()
        except httpx.StreamConsumed as exc:
            # The default error raised by httpx isn't very
            # helpful in our case so we re-raise it with
            # a different error message.
            raise StreamAlreadyConsumed() from exc

    def text(self) -> str:
        """Read and decode the response content into a string."""
        self.read()
        return self.http_response.text

    def json(self) -> object:
        """Read and decode the JSON response content."""
        self.read()
        return self.http_response.json()

    def close(self) -> None:
        """Close the response and release the connection.

        Automatically called if the response body is read to completion.
        """
        self.http_response.close()

    def iter_bytes(self, chunk_size: int | None = None) -> Iterator[bytes]:
        """
        A byte-iterator over the decoded response content.

        This automatically handles gzip, deflate and brotli encoded responses.
        """
        for chunk in self.http_response.iter_bytes(chunk_size):
            yield chunk

    def iter_text(self, chunk_size: int | None = None) -> Iterator[str]:
        """A str-iterator over the decoded response content
        that handles both gzip, deflate, etc but also detects the content's
        string encoding.
        """
        for chunk in self.http_response.iter_text(chunk_size):
            yield chunk

    def iter_lines(self) -> Iterator[str]:
        """Like `iter_text()` but will only yield chunks for each line"""
        for chunk in self.http_response.iter_lines():
            yield chunk


class AsyncAPIResponse(BaseAPIResponse[R]):
    @property
    def request_id(self) -> str | None:
        return self.http_response.headers.get("request-id")  # type: ignore[no-any-return]

    @overload
    async def parse(self, *, to: type[_T]) -> _T: ...

    @overload
    async def parse(self) -> R: ...

    async def parse(self, *, to: type[_T] | None = None) -> R | _T:
        """Returns the rich python representation of this response's data.

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
          - `httpx.Response`
        """
        cache_key = to if to is not None else self._cast_to
        cached = self._parsed_by_type.get(cache_key)
        if cached is not None:
            return cached  # type: ignore[no-any-return]

        if not self._is_sse_stream:
            await self.read()

        parsed = self._parse(to=to)
        if is_given(self._options.post_parser):
            parsed = self._options.post_parser(parsed)

        if isinstance(parsed, BaseModel):
            add_request_id(parsed, self.request_id)

        self._parsed_by_type[cache_key] = parsed
        return cast(R, parsed)

    async def read(self) -> bytes:
        """Read and return the binary response content."""
        try:
            return await self.http_response.aread()
        except httpx.StreamConsumed as exc:
            # the default error raised by httpx isn't very
            # helpful in our case so we re-raise it with
            # a different error message
            raise StreamAlreadyConsumed() from exc

    async def text(self) -> str:
        """Read and decode the response content into a string."""
        await self.read()
        return self.http_response.text

    async def json(self) -> object:
        """Read and decode the JSON response content."""
        await self.read()
        return self.http_response.json()

    async def close(self) -> None:
        """Close the response and release the connection.

        Automatically called if the response body is read to completion.
        """
        await self.http_response.aclose()

    async def iter_bytes(self, chunk_size: int | None = None) -> AsyncIterator[bytes]:
        """
        A byte-iterator over the decoded response content.

        This automatically handles gzip, deflate and brotli encoded responses.
        """
        async for chunk in self.http_response.aiter_bytes(chunk_size):
            yield chunk

    async def iter_text(self, chunk_size: int | None = None) -> AsyncIterator[str]:
        """A str-iterator over the decoded response content
        that handles both gzip, deflate, etc but also detects the content's
        string encoding.
        """
        async for chunk in self.http_response.aiter_text(chunk_size):
            yield chunk

    async def iter_lines(self) -> AsyncIterator[str]:
        """Like `iter_text()` but will only yield chunks for each line"""
        async for chunk in self.http_response.aiter_lines():
            yield chunk


class BinaryAPIResponse(APIResponse[bytes]):
    """Subclass of APIResponse providing helpers for dealing with binary data.

    Note: If you want to stream the response data instead of eagerly reading it
    all at once then you should use `.with_streaming_response` when making
    the API request, e.g. `.with_streaming_response.get_binary_response()`
    """

    def write_to_file(
        self,
        file: str | os.PathLike[str],
    ) -> None:
        """Write the output to the given file.

        Accepts a filename or any path-like object, e.g. pathlib.Path

        Note: if you want to stream the data to the file instead of writing
        all at once then you should use `.with_streaming_response` when making
        the API request, e.g. `.with_streaming_response.get_binary_response()`
        """
        with open(file, mode="wb") as f:
            for data in self.iter_bytes():
                f.write(data)


class AsyncBinaryAPIResponse(AsyncAPIResponse[bytes]):
    """Subclass of APIResponse providing helpers for dealing with binary data.

    Note: If you want to stream the response data instead of eagerly reading it
    all at once then you should use `.with_streaming_response` when making
    the API request, e.g. `.with_streaming_response.get_binary_response()`
    """

    async def write_to_file(
        self,
        file: str | os.PathLike[str],
    ) -> None:
        """Write the output to the given file.

        Accepts a filename or any path-like object, e.g. pathlib.Path

        Note: if you want to stream the data to the file instead of writing
        all at once then you should use `.with_streaming_response` when making
        the API request, e.g. `.with_streaming_response.get_binary_response()`
        """
        path = anyio.Path(file)
        async with await path.open(mode="wb") as f:
            async for data in self.iter_bytes():
                await f.write(data)


class StreamedBinaryAPIResponse(APIResponse[bytes]):
    def stream_to_file(
        self,
        file: str | os.PathLike[str],
        *,
        chunk_size: int | None = None,
    ) -> None:
        """Streams the output to the given file.

        Accepts a filename or any path-like object, e.g. pathlib.Path
        """
        with open(file, mode="wb") as f:
            for data in self.iter_bytes(chunk_size):
                f.write(data)


class AsyncStreamedBinaryAPIResponse(AsyncAPIResponse[bytes]):
    async def stream_to_file(
        self,
        file: str | os.PathLike[str],
        *,
        chunk_size: int | None = None,
    ) -> None:
        """Streams the output to the given file.

        Accepts a filename or any path-like object, e.g. pathlib.Path
        """
        path = anyio.Path(file)
        async with await path.open(mode="wb") as f:
            async for data in self.iter_bytes(chunk_size):
                await f.write(data)


class MissingStreamClassError(TypeError):
    def __init__(self) -> None:
        super().__init__(
            "The `stream` argument was set to `True` but the `stream_cls` argument was not given. See `anthropic._streaming` for reference",
        )


class StreamAlreadyConsumed(AnthropicError):
    """
    Attempted to read or stream content, but the content has already
    been streamed.

    This can happen if you use a method like `.iter_lines()` and then attempt
    to read th entire response body afterwards, e.g.

    ```py
    response = await client.post(...)
    async for line in response.iter_lines():
        ...  # do something with `line`

    content = await response.read()
    # ^ error
    ```

    If you want this behaviour you'll need to either manually accumulate the response
    content or call `await response.read()` before iterating over the stream.
    """

    def __init__(self) -> None:
        message = (
            "Attempted to read or stream some content, but the content has "
            "already been streamed. "
            "This could be due to attempting to stream the response "
            "content more than once."
            "\n\n"
            "You can fix this by manually accumulating the response content while streaming "
            "or by calling `.read()` before starting to stream."
        )
        super().__init__(message)


class ResponseContextManager(Generic[_APIResponseT]):
    """Context manager for ensuring that a request is not made
    until it is entered and that the response will always be closed
    when the context manager exits
    """

    def __init__(self, request_func: Callable[[], _APIResponseT]) -> None:
        self._request_func = request_func
        self.__response: _APIResponseT | None = None

    def __enter__(self) -> _APIResponseT:
        self.__response = self._request_func()
        return self.__response

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if self.__response is not None:
            self.__response.close()


class AsyncResponseContextManager(Generic[_AsyncAPIResponseT]):
    """Context manager for ensuring that a request is not made
    until it is entered and that the response will always be closed
    when the context manager exits
    """

    def __init__(self, api_request: Awaitable[_AsyncAPIResponseT]) -> None:
        self._api_request = api_request
        self.__response: _AsyncAPIResponseT | None = None

    async def __aenter__(self) -> _AsyncAPIResponseT:
        self.__response = await self._api_request
        return self.__response

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if self.__response is not None:
            await self.__response.close()


def to_streamed_response_wrapper(func: Callable[P, R]) -> Callable[P, ResponseContextManager[APIResponse[R]]]:
    """Higher order function that takes one of our bound API methods and wraps it
    to support streaming and returning the raw `APIResponse` object directly.
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> ResponseContextManager[APIResponse[R]]:
        extra_headers: dict[str, str] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "stream"

        kwargs["extra_headers"] = extra_headers

        make_request = functools.partial(func, *args, **kwargs)

        return ResponseContextManager(cast(Callable[[], APIResponse[R]], make_request))

    return wrapped


def async_to_streamed_response_wrapper(
    func: Callable[P, Awaitable[R]],
) -> Callable[P, AsyncResponseContextManager[AsyncAPIResponse[R]]]:
    """Higher order function that takes one of our bound API methods and wraps it
    to support streaming and returning the raw `APIResponse` object directly.
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> AsyncResponseContextManager[AsyncAPIResponse[R]]:
        extra_headers: dict[str, str] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "stream"

        kwargs["extra_headers"] = extra_headers

        make_request = func(*args, **kwargs)

        return AsyncResponseContextManager(cast(Awaitable[AsyncAPIResponse[R]], make_request))

    return wrapped


def to_custom_streamed_response_wrapper(
    func: Callable[P, object],
    response_cls: type[_APIResponseT],
) -> Callable[P, ResponseContextManager[_APIResponseT]]:
    """Higher order function that takes one of our bound API methods and an `APIResponse` class
    and wraps the method to support streaming and returning the given response class directly.

    Note: the given `response_cls` *must* be concrete, e.g. `class BinaryAPIResponse(APIResponse[bytes])`
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> ResponseContextManager[_APIResponseT]:
        extra_headers: dict[str, Any] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "stream"
        extra_headers[OVERRIDE_CAST_TO_HEADER] = response_cls

        kwargs["extra_headers"] = extra_headers

        make_request = functools.partial(func, *args, **kwargs)

        return ResponseContextManager(cast(Callable[[], _APIResponseT], make_request))

    return wrapped


def async_to_custom_streamed_response_wrapper(
    func: Callable[P, Awaitable[object]],
    response_cls: type[_AsyncAPIResponseT],
) -> Callable[P, AsyncResponseContextManager[_AsyncAPIResponseT]]:
    """Higher order function that takes one of our bound API methods and an `APIResponse` class
    and wraps the method to support streaming and returning the given response class directly.

    Note: the given `response_cls` *must* be concrete, e.g. `class BinaryAPIResponse(APIResponse[bytes])`
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> AsyncResponseContextManager[_AsyncAPIResponseT]:
        extra_headers: dict[str, Any] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "stream"
        extra_headers[OVERRIDE_CAST_TO_HEADER] = response_cls

        kwargs["extra_headers"] = extra_headers

        make_request = func(*args, **kwargs)

        return AsyncResponseContextManager(cast(Awaitable[_AsyncAPIResponseT], make_request))

    return wrapped


def to_raw_response_wrapper(func: Callable[P, R]) -> Callable[P, APIResponse[R]]:
    """Higher order function that takes one of our bound API methods and wraps it
    to support returning the raw `APIResponse` object directly.
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> APIResponse[R]:
        extra_headers: dict[str, str] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "raw"

        kwargs["extra_headers"] = extra_headers

        return cast(APIResponse[R], func(*args, **kwargs))

    return wrapped


def async_to_raw_response_wrapper(func: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[AsyncAPIResponse[R]]]:
    """Higher order function that takes one of our bound API methods and wraps it
    to support returning the raw `APIResponse` object directly.
    """

    @functools.wraps(func)
    async def wrapped(*args: P.args, **kwargs: P.kwargs) -> AsyncAPIResponse[R]:
        extra_headers: dict[str, str] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "raw"

        kwargs["extra_headers"] = extra_headers

        return cast(AsyncAPIResponse[R], await func(*args, **kwargs))

    return wrapped


def to_custom_raw_response_wrapper(
    func: Callable[P, object],
    response_cls: type[_APIResponseT],
) -> Callable[P, _APIResponseT]:
    """Higher order function that takes one of our bound API methods and an `APIResponse` class
    and wraps the method to support returning the given response class directly.

    Note: the given `response_cls` *must* be concrete, e.g. `class BinaryAPIResponse(APIResponse[bytes])`
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> _APIResponseT:
        extra_headers: dict[str, Any] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "raw"
        extra_headers[OVERRIDE_CAST_TO_HEADER] = response_cls

        kwargs["extra_headers"] = extra_headers

        return cast(_APIResponseT, func(*args, **kwargs))

    return wrapped


def async_to_custom_raw_response_wrapper(
    func: Callable[P, Awaitable[object]],
    response_cls: type[_AsyncAPIResponseT],
) -> Callable[P, Awaitable[_AsyncAPIResponseT]]:
    """Higher order function that takes one of our bound API methods and an `APIResponse` class
    and wraps the method to support returning the given response class directly.

    Note: the given `response_cls` *must* be concrete, e.g. `class BinaryAPIResponse(APIResponse[bytes])`
    """

    @functools.wraps(func)
    def wrapped(*args: P.args, **kwargs: P.kwargs) -> Awaitable[_AsyncAPIResponseT]:
        extra_headers: dict[str, Any] = {**(cast(Any, kwargs.get("extra_headers")) or {})}
        extra_headers[RAW_RESPONSE_HEADER] = "raw"
        extra_headers[OVERRIDE_CAST_TO_HEADER] = response_cls

        kwargs["extra_headers"] = extra_headers

        return cast(Awaitable[_AsyncAPIResponseT], func(*args, **kwargs))

    return wrapped


def extract_response_type(typ: type[BaseAPIResponse[Any]]) -> type:
    """Given a type like `APIResponse[T]`, returns the generic type variable `T`.

    This also handles the case where a concrete subclass is given, e.g.
    ```py
    class MyResponse(APIResponse[bytes]):
        ...

    extract_response_type(MyResponse) -> bytes
    ```
    """
    return extract_type_var_from_base(
        typ,
        generic_bases=cast("tuple[type, ...]", (BaseAPIResponse, APIResponse, AsyncAPIResponse)),
        index=0,
    )
