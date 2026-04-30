from __future__ import annotations

import json
from typing_extensions import Generic, TypeVar, Iterator, AsyncIterator

import httpx

from .._models import construct_type_unchecked

_T = TypeVar("_T")


class JSONLDecoder(Generic[_T]):
    """A decoder for [JSON Lines](https://jsonlines.org) format.

    This class provides an iterator over a byte-iterator that parses each JSON Line
    into a given type.
    """

    http_response: httpx.Response
    """The HTTP response this decoder was constructed from"""

    def __init__(
        self,
        *,
        raw_iterator: Iterator[bytes],
        line_type: type[_T],
        http_response: httpx.Response,
    ) -> None:
        super().__init__()
        self.http_response = http_response
        self._raw_iterator = raw_iterator
        self._line_type = line_type
        self._iterator = self.__decode__()

    def close(self) -> None:
        """Close the response body stream.

        This is called automatically if you consume the entire stream.
        """
        self.http_response.close()

    def __decode__(self) -> Iterator[_T]:
        buf = b""
        for chunk in self._raw_iterator:
            for line in chunk.splitlines(keepends=True):
                buf += line
                if buf.endswith((b"\r", b"\n", b"\r\n")):
                    yield construct_type_unchecked(
                        value=json.loads(buf),
                        type_=self._line_type,
                    )
                    buf = b""

        # flush
        if buf:
            yield construct_type_unchecked(
                value=json.loads(buf),
                type_=self._line_type,
            )

    def __next__(self) -> _T:
        return self._iterator.__next__()

    def __iter__(self) -> Iterator[_T]:
        for item in self._iterator:
            yield item


class AsyncJSONLDecoder(Generic[_T]):
    """A decoder for [JSON Lines](https://jsonlines.org) format.

    This class provides an async iterator over a byte-iterator that parses each JSON Line
    into a given type.
    """

    http_response: httpx.Response

    def __init__(
        self,
        *,
        raw_iterator: AsyncIterator[bytes],
        line_type: type[_T],
        http_response: httpx.Response,
    ) -> None:
        super().__init__()
        self.http_response = http_response
        self._raw_iterator = raw_iterator
        self._line_type = line_type
        self._iterator = self.__decode__()

    async def close(self) -> None:
        """Close the response body stream.

        This is called automatically if you consume the entire stream.
        """
        await self.http_response.aclose()

    async def __decode__(self) -> AsyncIterator[_T]:
        buf = b""
        async for chunk in self._raw_iterator:
            for line in chunk.splitlines(keepends=True):
                buf += line
                if buf.endswith((b"\r", b"\n", b"\r\n")):
                    yield construct_type_unchecked(
                        value=json.loads(buf),
                        type_=self._line_type,
                    )
                    buf = b""

        # flush
        if buf:
            yield construct_type_unchecked(
                value=json.loads(buf),
                type_=self._line_type,
            )

    async def __anext__(self) -> _T:
        return await self._iterator.__anext__()

    async def __aiter__(self) -> AsyncIterator[_T]:
        async for item in self._iterator:
            yield item
