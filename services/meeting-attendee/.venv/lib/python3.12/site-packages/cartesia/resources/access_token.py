# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional

import httpx

from ..types import access_token_create_params
from .._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from .._utils import maybe_transform, async_maybe_transform
from .._compat import cached_property
from .._resource import SyncAPIResource, AsyncAPIResource
from .._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from .._base_client import make_request_options
from ..types.access_token_create_response import AccessTokenCreateResponse

__all__ = ["AccessTokenResource", "AsyncAccessTokenResource"]


class AccessTokenResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AccessTokenResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AccessTokenResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AccessTokenResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AccessTokenResourceWithStreamingResponse(self)

    def create(
        self,
        *,
        expires_in: Optional[int] | Omit = omit,
        grants: Optional[access_token_create_params.Grants] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AccessTokenCreateResponse:
        """Generates a new Access Token for the client.

        These tokens are short-lived and
        should be used to make requests to the API from authenticated clients.

        Args:
          expires_in: The number of seconds the token will be valid for since the time of generation.
              The maximum is 1 hour (3600 seconds).

          grants: The permissions to be granted via the token. Both TTS and STT grants are
              optional - specify only the capabilities you need.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._post(
            "/access-token",
            body=maybe_transform(
                {
                    "expires_in": expires_in,
                    "grants": grants,
                },
                access_token_create_params.AccessTokenCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=AccessTokenCreateResponse,
        )


class AsyncAccessTokenResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncAccessTokenResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncAccessTokenResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncAccessTokenResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncAccessTokenResourceWithStreamingResponse(self)

    async def create(
        self,
        *,
        expires_in: Optional[int] | Omit = omit,
        grants: Optional[access_token_create_params.Grants] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AccessTokenCreateResponse:
        """Generates a new Access Token for the client.

        These tokens are short-lived and
        should be used to make requests to the API from authenticated clients.

        Args:
          expires_in: The number of seconds the token will be valid for since the time of generation.
              The maximum is 1 hour (3600 seconds).

          grants: The permissions to be granted via the token. Both TTS and STT grants are
              optional - specify only the capabilities you need.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return await self._post(
            "/access-token",
            body=await async_maybe_transform(
                {
                    "expires_in": expires_in,
                    "grants": grants,
                },
                access_token_create_params.AccessTokenCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=AccessTokenCreateResponse,
        )


class AccessTokenResourceWithRawResponse:
    def __init__(self, access_token: AccessTokenResource) -> None:
        self._access_token = access_token

        self.create = to_raw_response_wrapper(
            access_token.create,
        )


class AsyncAccessTokenResourceWithRawResponse:
    def __init__(self, access_token: AsyncAccessTokenResource) -> None:
        self._access_token = access_token

        self.create = async_to_raw_response_wrapper(
            access_token.create,
        )


class AccessTokenResourceWithStreamingResponse:
    def __init__(self, access_token: AccessTokenResource) -> None:
        self._access_token = access_token

        self.create = to_streamed_response_wrapper(
            access_token.create,
        )


class AsyncAccessTokenResourceWithStreamingResponse:
    def __init__(self, access_token: AsyncAccessTokenResource) -> None:
        self._access_token = access_token

        self.create = async_to_streamed_response_wrapper(
            access_token.create,
        )
