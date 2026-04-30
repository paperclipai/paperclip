from __future__ import annotations

from typing import TypeVar

import httpx

from ..._client import Anthropic, AsyncAnthropic
from ..._streaming import Stream, AsyncStream
from ._stream_decoder import AWSEventStreamDecoder

_T = TypeVar("_T")


class BedrockStream(Stream[_T]):
    def __init__(
        self,
        *,
        cast_to: type[_T],
        response: httpx.Response,
        client: Anthropic,
    ) -> None:
        super().__init__(cast_to=cast_to, response=response, client=client)

        self._decoder = AWSEventStreamDecoder()


class AsyncBedrockStream(AsyncStream[_T]):
    def __init__(
        self,
        *,
        cast_to: type[_T],
        response: httpx.Response,
        client: AsyncAnthropic,
    ) -> None:
        super().__init__(cast_to=cast_to, response=response, client=client)

        self._decoder = AWSEventStreamDecoder()
