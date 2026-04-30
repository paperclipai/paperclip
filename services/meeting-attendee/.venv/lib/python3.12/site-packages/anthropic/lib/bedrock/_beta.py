# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from ..._compat import cached_property
from ..._resource import SyncAPIResource, AsyncAPIResource
from ._beta_messages import (
    Messages,
    AsyncMessages,
    MessagesWithRawResponse,
    AsyncMessagesWithRawResponse,
    MessagesWithStreamingResponse,
    AsyncMessagesWithStreamingResponse,
)

__all__ = ["Beta", "AsyncBeta"]


class Beta(SyncAPIResource):
    @cached_property
    def messages(self) -> Messages:
        return Messages(self._client)

    @cached_property
    def with_raw_response(self) -> BetaWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return the
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return BetaWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> BetaWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return BetaWithStreamingResponse(self)


class AsyncBeta(AsyncAPIResource):
    @cached_property
    def messages(self) -> AsyncMessages:
        return AsyncMessages(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncBetaWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return the
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncBetaWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncBetaWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncBetaWithStreamingResponse(self)


class BetaWithRawResponse:
    def __init__(self, beta: Beta) -> None:
        self._beta = beta

    @cached_property
    def messages(self) -> MessagesWithRawResponse:
        return MessagesWithRawResponse(self._beta.messages)


class AsyncBetaWithRawResponse:
    def __init__(self, beta: AsyncBeta) -> None:
        self._beta = beta

    @cached_property
    def messages(self) -> AsyncMessagesWithRawResponse:
        return AsyncMessagesWithRawResponse(self._beta.messages)


class BetaWithStreamingResponse:
    def __init__(self, beta: Beta) -> None:
        self._beta = beta

    @cached_property
    def messages(self) -> MessagesWithStreamingResponse:
        return MessagesWithStreamingResponse(self._beta.messages)


class AsyncBetaWithStreamingResponse:
    def __init__(self, beta: AsyncBeta) -> None:
        self._beta = beta

    @cached_property
    def messages(self) -> AsyncMessagesWithStreamingResponse:
        return AsyncMessagesWithStreamingResponse(self._beta.messages)
