# Note: initially copied from https://github.com/florimondmanca/httpx-sse/blob/master/src/httpx_sse/_decoders.py
from __future__ import annotations

import abc
import json
import inspect
import warnings
from types import TracebackType
from typing import TYPE_CHECKING, Any, Generic, TypeVar, Iterator, Optional, AsyncIterator, cast
from typing_extensions import Self, Protocol, TypeGuard, override, get_origin, runtime_checkable

import httpx

from ._utils import is_dict, extract_type_var_from_base

if TYPE_CHECKING:
    from ._client import Anthropic, AsyncAnthropic
    from ._models import FinalRequestOptions


_T = TypeVar("_T")


class _SyncStreamMeta(abc.ABCMeta):
    @override
    def __instancecheck__(self, instance: Any) -> bool:
        # we override the `isinstance()` check for `Stream`
        # as a previous version of the `MessageStream` class
        # inherited from `Stream` & without this workaround,
        # changing it to not inherit would be a breaking change.

        from .lib.streaming import MessageStream

        if isinstance(instance, MessageStream):
            warnings.warn(
                "Using `isinstance()` to check if a `MessageStream` object is an instance of `Stream` is deprecated & will be removed in the next major version",
                DeprecationWarning,
                stacklevel=2,
            )
            return True

        return False


class Stream(Generic[_T], metaclass=_SyncStreamMeta):
    """Provides the core interface to iterate over a synchronous stream response."""

    response: httpx.Response
    _options: Optional[FinalRequestOptions] = None
    _decoder: SSEBytesDecoder

    def __init__(
        self,
        *,
        cast_to: type[_T],
        response: httpx.Response,
        client: Anthropic,
        options: Optional[FinalRequestOptions] = None,
    ) -> None:
        self.response = response
        self._cast_to = cast_to
        self._client = client
        self._options = options
        self._decoder = client._make_sse_decoder()
        self._iterator = self.__stream__()

    def __next__(self) -> _T:
        return self._iterator.__next__()

    def __iter__(self) -> Iterator[_T]:
        for item in self._iterator:
            yield item

    def _iter_events(self) -> Iterator[ServerSentEvent]:
        yield from self._decoder.iter_bytes(self.response.iter_bytes())

    def __stream__(self) -> Iterator[_T]:
        cast_to = cast(Any, self._cast_to)
        response = self.response
        process_data = self._client._process_response_data
        iterator = self._iter_events()

        try:
            for sse in iterator:
                if sse.event == "completion":
                    yield process_data(data=sse.json(), cast_to=cast_to, response=response)

                if (
                    sse.event == "message_start"
                    or sse.event == "message_delta"
                    or sse.event == "message_stop"
                    or sse.event == "content_block_start"
                    or sse.event == "content_block_delta"
                    or sse.event == "content_block_stop"
                    or sse.event == "message"
                    or sse.event == "user.message"
                    or sse.event == "user.interrupt"
                    or sse.event == "user.tool_confirmation"
                    or sse.event == "user.custom_tool_result"
                    or sse.event == "agent.message"
                    or sse.event == "agent.thinking"
                    or sse.event == "agent.tool_use"
                    or sse.event == "agent.tool_result"
                    or sse.event == "agent.mcp_tool_use"
                    or sse.event == "agent.mcp_tool_result"
                    or sse.event == "agent.custom_tool_use"
                    or sse.event == "agent.thread_context_compacted"
                    or sse.event == "session.status_running"
                    or sse.event == "session.status_idle"
                    or sse.event == "session.status_rescheduled"
                    or sse.event == "session.status_terminated"
                    or sse.event == "session.error"
                    or sse.event == "session.deleted"
                    or sse.event == "span.model_request_start"
                    or sse.event == "span.model_request_end"
                ):
                    data = sse.json()
                    if is_dict(data) and "type" not in data:
                        data["type"] = sse.event

                    yield process_data(data=data, cast_to=cast_to, response=response)

                if sse.event == "ping":
                    continue

                if sse.event == "error":
                    body = sse.data

                    try:
                        body = sse.json()
                        err_msg = f"{body}"
                    except Exception:
                        err_msg = sse.data or f"Error code: {response.status_code}"

                    raise self._client._make_status_error(
                        err_msg,
                        body=body,
                        response=self.response,
                    )
        finally:
            # Ensure the response is closed even if the consumer doesn't read all data
            response.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        self.close()

    def close(self) -> None:
        """
        Close the response and release the connection.

        Automatically called if the response body is read to completion.
        """
        self.response.close()


class _AsyncStreamMeta(abc.ABCMeta):
    @override
    def __instancecheck__(self, instance: Any) -> bool:
        # we override the `isinstance()` check for `AsyncStream`
        # as a previous version of the `AsyncMessageStream` class
        # inherited from `AsyncStream` & without this workaround,
        # changing it to not inherit would be a breaking change.

        from .lib.streaming import AsyncMessageStream

        if isinstance(instance, AsyncMessageStream):
            warnings.warn(
                "Using `isinstance()` to check if a `AsyncMessageStream` object is an instance of `AsyncStream` is deprecated & will be removed in the next major version",
                DeprecationWarning,
                stacklevel=2,
            )
            return True

        return False


class AsyncStream(Generic[_T], metaclass=_AsyncStreamMeta):
    """Provides the core interface to iterate over an asynchronous stream response."""

    response: httpx.Response
    _options: Optional[FinalRequestOptions] = None
    _decoder: SSEDecoder | SSEBytesDecoder

    def __init__(
        self,
        *,
        cast_to: type[_T],
        response: httpx.Response,
        client: AsyncAnthropic,
        options: Optional[FinalRequestOptions] = None,
    ) -> None:
        self.response = response
        self._cast_to = cast_to
        self._client = client
        self._options = options
        self._decoder = client._make_sse_decoder()
        self._iterator = self.__stream__()

    async def __anext__(self) -> _T:
        return await self._iterator.__anext__()

    async def __aiter__(self) -> AsyncIterator[_T]:
        async for item in self._iterator:
            yield item

    async def _iter_events(self) -> AsyncIterator[ServerSentEvent]:
        async for sse in self._decoder.aiter_bytes(self.response.aiter_bytes()):
            yield sse

    async def __stream__(self) -> AsyncIterator[_T]:
        cast_to = cast(Any, self._cast_to)
        response = self.response
        process_data = self._client._process_response_data
        iterator = self._iter_events()

        try:
            async for sse in iterator:
                if sse.event == "completion":
                    yield process_data(data=sse.json(), cast_to=cast_to, response=response)

                if (
                    sse.event == "message_start"
                    or sse.event == "message_delta"
                    or sse.event == "message_stop"
                    or sse.event == "content_block_start"
                    or sse.event == "content_block_delta"
                    or sse.event == "content_block_stop"
                    or sse.event == "message"
                    or sse.event == "user.message"
                    or sse.event == "user.interrupt"
                    or sse.event == "user.tool_confirmation"
                    or sse.event == "user.custom_tool_result"
                    or sse.event == "agent.message"
                    or sse.event == "agent.thinking"
                    or sse.event == "agent.tool_use"
                    or sse.event == "agent.tool_result"
                    or sse.event == "agent.mcp_tool_use"
                    or sse.event == "agent.mcp_tool_result"
                    or sse.event == "agent.custom_tool_use"
                    or sse.event == "agent.thread_context_compacted"
                    or sse.event == "session.status_running"
                    or sse.event == "session.status_idle"
                    or sse.event == "session.status_rescheduled"
                    or sse.event == "session.status_terminated"
                    or sse.event == "session.error"
                    or sse.event == "session.deleted"
                    or sse.event == "span.model_request_start"
                    or sse.event == "span.model_request_end"
                ):
                    data = sse.json()
                    if is_dict(data) and "type" not in data:
                        data["type"] = sse.event

                    yield process_data(data=data, cast_to=cast_to, response=response)

                if sse.event == "ping":
                    continue

                if sse.event == "error":
                    body = sse.data

                    try:
                        body = sse.json()
                        err_msg = f"{body}"
                    except Exception:
                        err_msg = sse.data or f"Error code: {response.status_code}"

                    raise self._client._make_status_error(
                        err_msg,
                        body=body,
                        response=self.response,
                    )
        finally:
            # Ensure the response is closed even if the consumer doesn't read all data
            await response.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """
        Close the response and release the connection.

        Automatically called if the response body is read to completion.
        """
        await self.response.aclose()


class ServerSentEvent:
    def __init__(
        self,
        *,
        event: str | None = None,
        data: str | None = None,
        id: str | None = None,
        retry: int | None = None,
    ) -> None:
        if data is None:
            data = ""

        self._id = id
        self._data = data
        self._event = event or None
        self._retry = retry

    @property
    def event(self) -> str | None:
        return self._event

    @property
    def id(self) -> str | None:
        return self._id

    @property
    def retry(self) -> int | None:
        return self._retry

    @property
    def data(self) -> str:
        return self._data

    def json(self) -> Any:
        return json.loads(self.data)

    @override
    def __repr__(self) -> str:
        return f"ServerSentEvent(event={self.event}, data={self.data}, id={self.id}, retry={self.retry})"


class SSEDecoder:
    _data: list[str]
    _event: str | None
    _retry: int | None
    _last_event_id: str | None

    def __init__(self) -> None:
        self._event = None
        self._data = []
        self._last_event_id = None
        self._retry = None

    def iter_bytes(self, iterator: Iterator[bytes]) -> Iterator[ServerSentEvent]:
        """Given an iterator that yields raw binary data, iterate over it & yield every event encountered"""
        for chunk in self._iter_chunks(iterator):
            # Split before decoding so splitlines() only uses \r and \n
            for raw_line in chunk.splitlines():
                line = raw_line.decode("utf-8")
                sse = self.decode(line)
                if sse:
                    yield sse

    def _iter_chunks(self, iterator: Iterator[bytes]) -> Iterator[bytes]:
        """Given an iterator that yields raw binary data, iterate over it and yield individual SSE chunks"""
        data = b""
        for chunk in iterator:
            for line in chunk.splitlines(keepends=True):
                data += line
                if data.endswith((b"\r\r", b"\n\n", b"\r\n\r\n")):
                    yield data
                    data = b""
        if data:
            yield data

    async def aiter_bytes(self, iterator: AsyncIterator[bytes]) -> AsyncIterator[ServerSentEvent]:
        """Given an iterator that yields raw binary data, iterate over it & yield every event encountered"""
        async for chunk in self._aiter_chunks(iterator):
            # Split before decoding so splitlines() only uses \r and \n
            for raw_line in chunk.splitlines():
                line = raw_line.decode("utf-8")
                sse = self.decode(line)
                if sse:
                    yield sse

    async def _aiter_chunks(self, iterator: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
        """Given an iterator that yields raw binary data, iterate over it and yield individual SSE chunks"""
        data = b""
        async for chunk in iterator:
            for line in chunk.splitlines(keepends=True):
                data += line
                if data.endswith((b"\r\r", b"\n\n", b"\r\n\r\n")):
                    yield data
                    data = b""
        if data:
            yield data

    def decode(self, line: str) -> ServerSentEvent | None:
        # See: https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation  # noqa: E501

        if not line:
            if not self._event and not self._data and not self._last_event_id and self._retry is None:
                return None

            sse = ServerSentEvent(
                event=self._event,
                data="\n".join(self._data),
                id=self._last_event_id,
                retry=self._retry,
            )

            # NOTE: as per the SSE spec, do not reset last_event_id.
            self._event = None
            self._data = []
            self._retry = None

            return sse

        if line.startswith(":"):
            return None

        fieldname, _, value = line.partition(":")

        if value.startswith(" "):
            value = value[1:]

        if fieldname == "event":
            self._event = value
        elif fieldname == "data":
            self._data.append(value)
        elif fieldname == "id":
            if "\0" in value:
                pass
            else:
                self._last_event_id = value
        elif fieldname == "retry":
            try:
                self._retry = int(value)
            except (TypeError, ValueError):
                pass
        else:
            pass  # Field is ignored.

        return None


@runtime_checkable
class SSEBytesDecoder(Protocol):
    def iter_bytes(self, iterator: Iterator[bytes]) -> Iterator[ServerSentEvent]:
        """Given an iterator that yields raw binary data, iterate over it & yield every event encountered"""
        ...

    def aiter_bytes(self, iterator: AsyncIterator[bytes]) -> AsyncIterator[ServerSentEvent]:
        """Given an async iterator that yields raw binary data, iterate over it & yield every event encountered"""
        ...


def is_stream_class_type(typ: type) -> TypeGuard[type[Stream[object]] | type[AsyncStream[object]]]:
    """TypeGuard for determining whether or not the given type is a subclass of `Stream` / `AsyncStream`"""
    origin = get_origin(typ) or typ
    return inspect.isclass(origin) and issubclass(origin, (Stream, AsyncStream))


def extract_stream_chunk_type(
    stream_cls: type,
    *,
    failure_message: str | None = None,
) -> type:
    """Given a type like `Stream[T]`, returns the generic type variable `T`.

    This also handles the case where a concrete subclass is given, e.g.
    ```py
    class MyStream(Stream[bytes]):
        ...

    extract_stream_chunk_type(MyStream) -> bytes
    ```
    """
    from ._base_client import Stream, AsyncStream

    return extract_type_var_from_base(
        stream_cls,
        index=0,
        generic_bases=cast("tuple[type, ...]", (Stream, AsyncStream)),
        failure_message=failure_message,
    )
