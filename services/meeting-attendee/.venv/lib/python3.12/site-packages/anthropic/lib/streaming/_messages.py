from __future__ import annotations

from types import TracebackType
from typing import TYPE_CHECKING, Any, Type, Generic, Callable, cast
from typing_extensions import Self, Iterator, Awaitable, AsyncIterator, assert_never

import httpx
from pydantic import BaseModel

from anthropic.types.tool_use_block import ToolUseBlock
from anthropic.types.server_tool_use_block import ServerToolUseBlock

from ._types import (
    TextEvent,
    CitationEvent,
    ThinkingEvent,
    InputJsonEvent,
    SignatureEvent,
    ParsedMessageStopEvent,
    ParsedMessageStreamEvent,
    ParsedContentBlockStopEvent,
)
from ...types import RawMessageStreamEvent
from ..._types import NOT_GIVEN, NotGiven
from ..._utils import consume_sync_iterator, consume_async_iterator
from ..._models import build, construct_type, construct_type_unchecked
from ..._streaming import Stream, AsyncStream
from ..._utils._utils import is_given
from .._parse._response import ResponseFormatT, parse_text
from ...types.parsed_message import ParsedMessage, ParsedContentBlock


class MessageStream(Generic[ResponseFormatT]):
    text_stream: Iterator[str]
    """Iterator over just the text deltas in the stream.

    ```py
    for text in stream.text_stream:
        print(text, end="", flush=True)
    print()
    ```
    """

    def __init__(
        self,
        raw_stream: Stream[RawMessageStreamEvent],
        output_format: ResponseFormatT | NotGiven,
    ) -> None:
        self._raw_stream = raw_stream
        self.text_stream = self.__stream_text__()
        self._iterator = self.__stream__()
        self.__final_message_snapshot: ParsedMessage[ResponseFormatT] | None = None
        self.__output_format = output_format

    @property
    def response(self) -> httpx.Response:
        return self._raw_stream.response

    @property
    def request_id(self) -> str | None:
        return self.response.headers.get("request-id")  # type: ignore[no-any-return]

    def __next__(self) -> ParsedMessageStreamEvent[ResponseFormatT]:
        return self._iterator.__next__()

    def __iter__(self) -> Iterator[ParsedMessageStreamEvent[ResponseFormatT]]:
        for item in self._iterator:
            yield item

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
        self._raw_stream.close()

    def get_final_message(self) -> ParsedMessage[ResponseFormatT]:
        """Waits until the stream has been read to completion and returns
        the accumulated `Message` object.
        """
        self.until_done()
        assert self.__final_message_snapshot is not None
        return self.__final_message_snapshot

    def get_final_text(self) -> str:
        """Returns all `text` content blocks concatenated together.

        > [!NOTE]
        > Currently the API will only respond with a single content block.

        Will raise an error if no `text` content blocks were returned.
        """
        message = self.get_final_message()
        text_blocks: list[str] = []
        for block in message.content:
            if block.type == "text":
                text_blocks.append(block.text)

        if not text_blocks:
            raise RuntimeError(
                f".get_final_text() can only be called when the API returns a `text` content block.\nThe API returned {','.join([b.type for b in message.content])} content block type(s) that you can access by calling get_final_message().content"
            )

        return "".join(text_blocks)

    def until_done(self) -> None:
        """Blocks until the stream has been consumed"""
        consume_sync_iterator(self)

    # properties
    @property
    def current_message_snapshot(self) -> ParsedMessage[ResponseFormatT]:
        assert self.__final_message_snapshot is not None
        return self.__final_message_snapshot

    def __stream__(self) -> Iterator[ParsedMessageStreamEvent[ResponseFormatT]]:
        for sse_event in self._raw_stream:
            self.__final_message_snapshot = accumulate_event(
                event=sse_event,
                current_snapshot=self.__final_message_snapshot,
                output_format=self.__output_format,
            )

            events_to_fire = build_events(event=sse_event, message_snapshot=self.current_message_snapshot)
            for event in events_to_fire:
                yield event

    def __stream_text__(self) -> Iterator[str]:
        for chunk in self:
            if chunk.type == "content_block_delta" and chunk.delta.type == "text_delta":
                yield chunk.delta.text


class MessageStreamManager(Generic[ResponseFormatT]):
    """Wrapper over MessageStream that is returned by `.stream()`.

    ```py
    with client.messages.stream(...) as stream:
        for chunk in stream:
            ...
    ```
    """

    def __init__(
        self,
        api_request: Callable[[], Stream[RawMessageStreamEvent]],
        *,
        output_format: ResponseFormatT | NotGiven,
    ) -> None:
        self.__stream: MessageStream[ResponseFormatT] | None = None
        self.__api_request = api_request
        self.__output_format = output_format

    def __enter__(self) -> MessageStream[ResponseFormatT]:
        raw_stream = self.__api_request()
        self.__stream = MessageStream(raw_stream, output_format=self.__output_format)
        return self.__stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if self.__stream is not None:
            self.__stream.close()


class AsyncMessageStream(Generic[ResponseFormatT]):
    text_stream: AsyncIterator[str]
    """Async iterator over just the text deltas in the stream.

    ```py
    async for text in stream.text_stream:
        print(text, end="", flush=True)
    print()
    ```
    """

    def __init__(
        self,
        raw_stream: AsyncStream[RawMessageStreamEvent],
        output_format: ResponseFormatT | NotGiven,
    ) -> None:
        self._raw_stream = raw_stream
        self.text_stream = self.__stream_text__()
        self._iterator = self.__stream__()
        self.__final_message_snapshot: ParsedMessage[ResponseFormatT] | None = None
        self.__output_format = output_format

    @property
    def response(self) -> httpx.Response:
        return self._raw_stream.response

    @property
    def request_id(self) -> str | None:
        return self.response.headers.get("request-id")  # type: ignore[no-any-return]

    async def __anext__(self) -> ParsedMessageStreamEvent[ResponseFormatT]:
        return await self._iterator.__anext__()

    async def __aiter__(self) -> AsyncIterator[ParsedMessageStreamEvent[ResponseFormatT]]:
        async for item in self._iterator:
            yield item

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
        await self._raw_stream.close()

    async def get_final_message(self) -> ParsedMessage[ResponseFormatT]:
        """Waits until the stream has been read to completion and returns
        the accumulated `Message` object.
        """
        await self.until_done()
        assert self.__final_message_snapshot is not None
        return self.__final_message_snapshot

    async def get_final_text(self) -> str:
        """Returns all `text` content blocks concatenated together.

        > [!NOTE]
        > Currently the API will only respond with a single content block.

        Will raise an error if no `text` content blocks were returned.
        """
        message = await self.get_final_message()
        text_blocks: list[str] = []
        for block in message.content:
            if block.type == "text":
                text_blocks.append(block.text)

        if not text_blocks:
            raise RuntimeError(
                f".get_final_text() can only be called when the API returns a `text` content block.\nThe API returned {','.join([b.type for b in message.content])} content block type(s) that you can access by calling get_final_message().content"
            )

        return "".join(text_blocks)

    async def until_done(self) -> None:
        """Waits until the stream has been consumed"""
        await consume_async_iterator(self)

    # properties
    @property
    def current_message_snapshot(self) -> ParsedMessage[ResponseFormatT]:
        assert self.__final_message_snapshot is not None
        return self.__final_message_snapshot

    async def __stream__(self) -> AsyncIterator[ParsedMessageStreamEvent[ResponseFormatT]]:
        async for sse_event in self._raw_stream:
            self.__final_message_snapshot = accumulate_event(
                event=sse_event,
                current_snapshot=self.__final_message_snapshot,
                output_format=self.__output_format,
            )

            events_to_fire = build_events(event=sse_event, message_snapshot=self.current_message_snapshot)
            for event in events_to_fire:
                yield event

    async def __stream_text__(self) -> AsyncIterator[str]:
        async for chunk in self:
            if chunk.type == "content_block_delta" and chunk.delta.type == "text_delta":
                yield chunk.delta.text


class AsyncMessageStreamManager(Generic[ResponseFormatT]):
    """Wrapper over AsyncMessageStream that is returned by `.stream()`
    so that an async context manager can be used without `await`ing the
    original client call.

    ```py
    async with client.messages.stream(...) as stream:
        async for chunk in stream:
            ...
    ```
    """

    def __init__(
        self,
        api_request: Awaitable[AsyncStream[RawMessageStreamEvent]],
        *,
        output_format: ResponseFormatT | NotGiven = NOT_GIVEN,
    ) -> None:
        self.__stream: AsyncMessageStream[ResponseFormatT] | None = None
        self.__api_request = api_request
        self.__output_format = output_format

    async def __aenter__(self) -> AsyncMessageStream[ResponseFormatT]:
        raw_stream = await self.__api_request
        self.__stream = AsyncMessageStream(raw_stream, output_format=self.__output_format)
        return self.__stream

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        if self.__stream is not None:
            await self.__stream.close()


def build_events(
    *,
    event: RawMessageStreamEvent,
    message_snapshot: ParsedMessage[ResponseFormatT],
) -> list[ParsedMessageStreamEvent[ResponseFormatT]]:
    events_to_fire: list[ParsedMessageStreamEvent[ResponseFormatT]] = []

    if event.type == "message_start":
        events_to_fire.append(event)
    elif event.type == "message_delta":
        events_to_fire.append(event)
    elif event.type == "message_stop":
        events_to_fire.append(
            build(ParsedMessageStopEvent[ResponseFormatT], type="message_stop", message=message_snapshot)
        )
    elif event.type == "content_block_start":
        events_to_fire.append(event)
    elif event.type == "content_block_delta":
        events_to_fire.append(event)

        content_block = message_snapshot.content[event.index]
        if event.delta.type == "text_delta":
            if content_block.type == "text":
                events_to_fire.append(
                    build(
                        TextEvent,
                        type="text",
                        text=event.delta.text,
                        snapshot=content_block.text,
                    )
                )
        elif event.delta.type == "input_json_delta":
            if content_block.type == "tool_use":
                events_to_fire.append(
                    build(
                        InputJsonEvent,
                        type="input_json",
                        partial_json=event.delta.partial_json,
                        snapshot=content_block.input,
                    )
                )
        elif event.delta.type == "citations_delta":
            if content_block.type == "text":
                events_to_fire.append(
                    build(
                        CitationEvent,
                        type="citation",
                        citation=event.delta.citation,
                        snapshot=content_block.citations or [],
                    )
                )
        elif event.delta.type == "thinking_delta":
            if content_block.type == "thinking":
                events_to_fire.append(
                    build(
                        ThinkingEvent,
                        type="thinking",
                        thinking=event.delta.thinking,
                        snapshot=content_block.thinking,
                    )
                )
        elif event.delta.type == "signature_delta":
            if content_block.type == "thinking":
                events_to_fire.append(
                    build(
                        SignatureEvent,
                        type="signature",
                        signature=content_block.signature,
                    )
                )
            pass
        else:
            # we only want exhaustive checking for linters, not at runtime
            if TYPE_CHECKING:  # type: ignore[unreachable]
                assert_never(event.delta)
    elif event.type == "content_block_stop":
        content_block = message_snapshot.content[event.index]

        event_to_fire = build(
            ParsedContentBlockStopEvent,
            type="content_block_stop",
            index=event.index,
            content_block=content_block,
        )

        events_to_fire.append(event_to_fire)
    else:
        # we only want exhaustive checking for linters, not at runtime
        if TYPE_CHECKING:  # type: ignore[unreachable]
            assert_never(event)

    return events_to_fire


JSON_BUF_PROPERTY = "__json_buf"

TRACKS_TOOL_INPUT = (
    ToolUseBlock,
    ServerToolUseBlock,
)


def accumulate_event(
    *,
    event: RawMessageStreamEvent,
    current_snapshot: ParsedMessage[ResponseFormatT] | None,
    output_format: ResponseFormatT | NotGiven = NOT_GIVEN,
) -> ParsedMessage[ResponseFormatT]:
    if not isinstance(cast(Any, event), BaseModel):
        event = cast(  # pyright: ignore[reportUnnecessaryCast]
            RawMessageStreamEvent,
            construct_type_unchecked(
                type_=cast(Type[RawMessageStreamEvent], RawMessageStreamEvent),
                value=event,
            ),
        )
        if not isinstance(cast(Any, event), BaseModel):
            raise TypeError(f"Unexpected event runtime type, after deserialising twice - {event} - {type(event)}")

    if current_snapshot is None:
        if event.type == "message_start":
            return cast(ParsedMessage[ResponseFormatT], ParsedMessage.construct(**cast(Any, event.message.to_dict())))

        raise RuntimeError(f'Unexpected event order, got {event.type} before "message_start"')

    if event.type == "content_block_start":
        # TODO: check index
        current_snapshot.content.append(
            cast(
                Any,  # Pydantic does not support generic unions at runtime
                construct_type(type_=ParsedContentBlock, value=event.content_block.model_dump()),
            ),
        )
    elif event.type == "content_block_delta":
        content = current_snapshot.content[event.index]
        if event.delta.type == "text_delta":
            if content.type == "text":
                content.text += event.delta.text
        elif event.delta.type == "input_json_delta":
            if isinstance(content, TRACKS_TOOL_INPUT):
                from jiter import from_json

                # we need to keep track of the raw JSON string as well so that we can
                # re-parse it for each delta, for now we just store it as an untyped
                # property on the snapshot
                json_buf = cast(bytes, getattr(content, JSON_BUF_PROPERTY, b""))
                json_buf += bytes(event.delta.partial_json, "utf-8")

                if json_buf:
                    content.input = from_json(json_buf, partial_mode=True)

                setattr(content, JSON_BUF_PROPERTY, json_buf)
        elif event.delta.type == "citations_delta":
            if content.type == "text":
                if not content.citations:
                    content.citations = [event.delta.citation]
                else:
                    content.citations.append(event.delta.citation)
        elif event.delta.type == "thinking_delta":
            if content.type == "thinking":
                content.thinking += event.delta.thinking
        elif event.delta.type == "signature_delta":
            if content.type == "thinking":
                content.signature = event.delta.signature
        else:
            # we only want exhaustive checking for linters, not at runtime
            if TYPE_CHECKING:  # type: ignore[unreachable]
                assert_never(event.delta)
    elif event.type == "content_block_stop":
        content_block = current_snapshot.content[event.index]
        if content_block.type == "text" and is_given(output_format):
            content_block.parsed_output = parse_text(content_block.text, output_format)
    elif event.type == "message_delta":
        current_snapshot.stop_reason = event.delta.stop_reason
        current_snapshot.stop_sequence = event.delta.stop_sequence
        current_snapshot.usage.output_tokens = event.usage.output_tokens

        # Update other usage fields if they exist in the event
        if event.usage.input_tokens is not None:
            current_snapshot.usage.input_tokens = event.usage.input_tokens
        if event.usage.cache_creation_input_tokens is not None:
            current_snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens
        if event.usage.cache_read_input_tokens is not None:
            current_snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens
        if event.usage.server_tool_use is not None:
            current_snapshot.usage.server_tool_use = event.usage.server_tool_use

    return current_snapshot
