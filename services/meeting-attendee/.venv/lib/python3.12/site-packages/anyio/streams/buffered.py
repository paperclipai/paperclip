from __future__ import annotations

__all__ = (
    "BufferedByteReceiveStream",
    "BufferedByteStream",
    "BufferedConnectable",
)

import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, SupportsIndex

from .. import ClosedResourceError, DelimiterNotFound, EndOfStream, IncompleteRead
from ..abc import (
    AnyByteReceiveStream,
    AnyByteStream,
    AnyByteStreamConnectable,
    ByteReceiveStream,
    ByteStream,
    ByteStreamConnectable,
)

if sys.version_info >= (3, 12):
    from typing import override
else:
    from typing_extensions import override


@dataclass(eq=False)
class BufferedByteReceiveStream(ByteReceiveStream):
    """
    Wraps any bytes-based receive stream and uses a buffer to provide sophisticated
    receiving capabilities in the form of a byte stream.
    """

    receive_stream: AnyByteReceiveStream
    _buffer: bytearray = field(init=False, default_factory=bytearray)
    _closed: bool = field(init=False, default=False)

    async def aclose(self) -> None:
        await self.receive_stream.aclose()
        self._closed = True

    @property
    def buffer(self) -> bytes:
        """The bytes currently in the buffer."""
        return bytes(self._buffer)

    @property
    def extra_attributes(self) -> Mapping[Any, Callable[[], Any]]:
        return self.receive_stream.extra_attributes

    def feed_data(self, data: Iterable[SupportsIndex], /) -> None:
        """
        Append data directly into the buffer.

        Any data in the buffer will be consumed by receive operations before receiving
        anything from the wrapped stream.

        :param data: the data to append to the buffer (can be bytes or anything else
            that supports ``__index__()``)

        """
        self._buffer.extend(data)

    async def receive(self, max_bytes: int = 65536) -> bytes:
        if self._closed:
            raise ClosedResourceError

        if self._buffer:
            chunk = bytes(self._buffer[:max_bytes])
            del self._buffer[:max_bytes]
            return chunk
        elif isinstance(self.receive_stream, ByteReceiveStream):
            return await self.receive_stream.receive(max_bytes)
        else:
            # With a bytes-oriented object stream, we need to handle any surplus bytes
            # we get from the receive() call
            chunk = await self.receive_stream.receive()
            if len(chunk) > max_bytes:
                # Save the surplus bytes in the buffer
                self._buffer.extend(chunk[max_bytes:])
                return chunk[:max_bytes]
            else:
                return chunk

    async def receive_exactly(self, nbytes: int) -> bytes:
        """
        Read exactly the given amount of bytes from the stream.

        :param nbytes: the number of bytes to read
        :return: the bytes read
        :raises ~anyio.IncompleteRead: if the stream was closed before the requested
            amount of bytes could be read from the stream

        """
        while True:
            remaining = nbytes - len(self._buffer)
            if remaining <= 0:
                retval = self._buffer[:nbytes]
                del self._buffer[:nbytes]
                return bytes(retval)

            try:
                if isinstance(self.receive_stream, ByteReceiveStream):
                    chunk = await self.receive_stream.receive(remaining)
                else:
                    chunk = await self.receive_stream.receive()
            except EndOfStream as exc:
                raise IncompleteRead from exc

            self._buffer.extend(chunk)

    async def receive_until(self, delimiter: bytes, max_bytes: int) -> bytes:
        """
        Read from the stream until the delimiter is found or max_bytes have been read.

        :param delimiter: the marker to look for in the stream
        :param max_bytes: maximum number of bytes that will be read before raising
            :exc:`~anyio.DelimiterNotFound`
        :return: the bytes read (not including the delimiter)
        :raises ~anyio.IncompleteRead: if the stream was closed before the delimiter
            was found
        :raises ~anyio.DelimiterNotFound: if the delimiter is not found within the
            bytes read up to the maximum allowed

        """
        delimiter_size = len(delimiter)
        offset = 0
        while True:
            # Check if the delimiter can be found in the current buffer
            index = self._buffer.find(delimiter, offset)
            if index >= 0:
                found = self._buffer[:index]
                del self._buffer[: index + len(delimiter) :]
                return bytes(found)

            # Check if the buffer is already at or over the limit
            if len(self._buffer) >= max_bytes:
                raise DelimiterNotFound(max_bytes)

            # Read more data into the buffer from the socket
            try:
                data = await self.receive_stream.receive()
            except EndOfStream as exc:
                raise IncompleteRead from exc

            # Move the offset forward and add the new data to the buffer
            offset = max(len(self._buffer) - delimiter_size + 1, 0)
            self._buffer.extend(data)


class BufferedByteStream(BufferedByteReceiveStream, ByteStream):
    """
    A full-duplex variant of :class:`BufferedByteReceiveStream`. All writes are passed
    through to the wrapped stream as-is.
    """

    def __init__(self, stream: AnyByteStream):
        """
        :param stream: the stream to be wrapped

        """
        super().__init__(stream)
        self._stream = stream

    @override
    async def send_eof(self) -> None:
        await self._stream.send_eof()

    @override
    async def send(self, item: bytes) -> None:
        await self._stream.send(item)


class BufferedConnectable(ByteStreamConnectable):
    def __init__(self, connectable: AnyByteStreamConnectable):
        """
        :param connectable: the connectable to wrap

        """
        self.connectable = connectable

    @override
    async def connect(self) -> BufferedByteStream:
        stream = await self.connectable.connect()
        return BufferedByteStream(stream)
