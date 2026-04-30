# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional

import httpx

from ..types import fine_tune_list_params, fine_tune_create_params, fine_tune_list_voices_params
from .._types import Body, Omit, Query, Headers, NoneType, NotGiven, omit, not_given
from .._utils import maybe_transform, async_maybe_transform
from .._compat import cached_property
from .._resource import SyncAPIResource, AsyncAPIResource
from .._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from ..pagination import SyncCursorIDPage, AsyncCursorIDPage
from ..types.voice import Voice
from .._base_client import AsyncPaginator, make_request_options
from ..types.fine_tune import FineTune

__all__ = ["FineTunesResource", "AsyncFineTunesResource"]


class FineTunesResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> FineTunesResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return FineTunesResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> FineTunesResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return FineTunesResourceWithStreamingResponse(self)

    def create(
        self,
        *,
        dataset: str,
        description: str,
        language: str,
        model_id: str,
        name: str,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> FineTune:
        """
        Create a new fine-tune

        Args:
          dataset: Dataset ID containing training files

          description: Description for the fine-tune

          language: Language code for the fine-tune

          model_id: Base model ID to fine-tune from

          name: Name for the new fine-tune

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._post(
            "/fine-tunes/",
            body=maybe_transform(
                {
                    "dataset": dataset,
                    "description": description,
                    "language": language,
                    "model_id": model_id,
                    "name": name,
                },
                fine_tune_create_params.FineTuneCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=FineTune,
        )

    def retrieve(
        self,
        id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> FineTune:
        """
        Retrieve a specific fine-tune by ID

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._get(
            f"/fine-tunes/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=FineTune,
        )

    def list(
        self,
        *,
        ending_before: Optional[str] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncCursorIDPage[FineTune]:
        """
        Paginated list of all fine-tunes for the authenticated user

        Args:
          ending_before: A cursor to use in pagination. `ending_before` is a fine-tune ID that defines
              your place in the list. For example, if you make a /fine-tunes request and
              receive 20 objects, starting with `fine_tune_abc123`, your subsequent call can
              include `ending_before=fine_tune_abc123` to fetch the previous page of the list.

          limit: The number of fine-tunes to return per page, ranging between 1 and 100.

          starting_after: A cursor to use in pagination. `starting_after` is a fine-tune ID that defines
              your place in the list. For example, if you make a /fine-tunes request and
              receive 20 objects, ending with `fine_tune_abc123`, your subsequent call can
              include `starting_after=fine_tune_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/fine-tunes/",
            page=SyncCursorIDPage[FineTune],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "ending_before": ending_before,
                        "limit": limit,
                        "starting_after": starting_after,
                    },
                    fine_tune_list_params.FineTuneListParams,
                ),
            ),
            model=FineTune,
        )

    def delete(
        self,
        id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """
        Delete a fine-tune

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return self._delete(
            f"/fine-tunes/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )

    def list_voices(
        self,
        id: str,
        *,
        ending_before: Optional[str] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncCursorIDPage[Voice]:
        """
        List all voices created from a fine-tune

        Args:
          ending_before: A cursor to use in pagination. `ending_before` is a voice ID that defines your
              place in the list. For example, if you make a fine-tune voices request and
              receive 20 objects, starting with `voice_abc123`, your subsequent call can
              include `ending_before=voice_abc123` to fetch the previous page of the list.

          limit: The number of voices to return per page, ranging between 1 and 100.

          starting_after: A cursor to use in pagination. `starting_after` is a voice ID that defines your
              place in the list. For example, if you make a fine-tune voices request and
              receive 20 objects, ending with `voice_abc123`, your subsequent call can include
              `starting_after=voice_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._get_api_list(
            f"/fine-tunes/{id}/voices",
            page=SyncCursorIDPage[Voice],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "ending_before": ending_before,
                        "limit": limit,
                        "starting_after": starting_after,
                    },
                    fine_tune_list_voices_params.FineTuneListVoicesParams,
                ),
            ),
            model=Voice,
        )


class AsyncFineTunesResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncFineTunesResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncFineTunesResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncFineTunesResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncFineTunesResourceWithStreamingResponse(self)

    async def create(
        self,
        *,
        dataset: str,
        description: str,
        language: str,
        model_id: str,
        name: str,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> FineTune:
        """
        Create a new fine-tune

        Args:
          dataset: Dataset ID containing training files

          description: Description for the fine-tune

          language: Language code for the fine-tune

          model_id: Base model ID to fine-tune from

          name: Name for the new fine-tune

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return await self._post(
            "/fine-tunes/",
            body=await async_maybe_transform(
                {
                    "dataset": dataset,
                    "description": description,
                    "language": language,
                    "model_id": model_id,
                    "name": name,
                },
                fine_tune_create_params.FineTuneCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=FineTune,
        )

    async def retrieve(
        self,
        id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> FineTune:
        """
        Retrieve a specific fine-tune by ID

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return await self._get(
            f"/fine-tunes/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=FineTune,
        )

    def list(
        self,
        *,
        ending_before: Optional[str] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[FineTune, AsyncCursorIDPage[FineTune]]:
        """
        Paginated list of all fine-tunes for the authenticated user

        Args:
          ending_before: A cursor to use in pagination. `ending_before` is a fine-tune ID that defines
              your place in the list. For example, if you make a /fine-tunes request and
              receive 20 objects, starting with `fine_tune_abc123`, your subsequent call can
              include `ending_before=fine_tune_abc123` to fetch the previous page of the list.

          limit: The number of fine-tunes to return per page, ranging between 1 and 100.

          starting_after: A cursor to use in pagination. `starting_after` is a fine-tune ID that defines
              your place in the list. For example, if you make a /fine-tunes request and
              receive 20 objects, ending with `fine_tune_abc123`, your subsequent call can
              include `starting_after=fine_tune_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/fine-tunes/",
            page=AsyncCursorIDPage[FineTune],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "ending_before": ending_before,
                        "limit": limit,
                        "starting_after": starting_after,
                    },
                    fine_tune_list_params.FineTuneListParams,
                ),
            ),
            model=FineTune,
        )

    async def delete(
        self,
        id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """
        Delete a fine-tune

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return await self._delete(
            f"/fine-tunes/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )

    def list_voices(
        self,
        id: str,
        *,
        ending_before: Optional[str] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[Voice, AsyncCursorIDPage[Voice]]:
        """
        List all voices created from a fine-tune

        Args:
          ending_before: A cursor to use in pagination. `ending_before` is a voice ID that defines your
              place in the list. For example, if you make a fine-tune voices request and
              receive 20 objects, starting with `voice_abc123`, your subsequent call can
              include `ending_before=voice_abc123` to fetch the previous page of the list.

          limit: The number of voices to return per page, ranging between 1 and 100.

          starting_after: A cursor to use in pagination. `starting_after` is a voice ID that defines your
              place in the list. For example, if you make a fine-tune voices request and
              receive 20 objects, ending with `voice_abc123`, your subsequent call can include
              `starting_after=voice_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._get_api_list(
            f"/fine-tunes/{id}/voices",
            page=AsyncCursorIDPage[Voice],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "ending_before": ending_before,
                        "limit": limit,
                        "starting_after": starting_after,
                    },
                    fine_tune_list_voices_params.FineTuneListVoicesParams,
                ),
            ),
            model=Voice,
        )


class FineTunesResourceWithRawResponse:
    def __init__(self, fine_tunes: FineTunesResource) -> None:
        self._fine_tunes = fine_tunes

        self.create = to_raw_response_wrapper(
            fine_tunes.create,
        )
        self.retrieve = to_raw_response_wrapper(
            fine_tunes.retrieve,
        )
        self.list = to_raw_response_wrapper(
            fine_tunes.list,
        )
        self.delete = to_raw_response_wrapper(
            fine_tunes.delete,
        )
        self.list_voices = to_raw_response_wrapper(
            fine_tunes.list_voices,
        )


class AsyncFineTunesResourceWithRawResponse:
    def __init__(self, fine_tunes: AsyncFineTunesResource) -> None:
        self._fine_tunes = fine_tunes

        self.create = async_to_raw_response_wrapper(
            fine_tunes.create,
        )
        self.retrieve = async_to_raw_response_wrapper(
            fine_tunes.retrieve,
        )
        self.list = async_to_raw_response_wrapper(
            fine_tunes.list,
        )
        self.delete = async_to_raw_response_wrapper(
            fine_tunes.delete,
        )
        self.list_voices = async_to_raw_response_wrapper(
            fine_tunes.list_voices,
        )


class FineTunesResourceWithStreamingResponse:
    def __init__(self, fine_tunes: FineTunesResource) -> None:
        self._fine_tunes = fine_tunes

        self.create = to_streamed_response_wrapper(
            fine_tunes.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            fine_tunes.retrieve,
        )
        self.list = to_streamed_response_wrapper(
            fine_tunes.list,
        )
        self.delete = to_streamed_response_wrapper(
            fine_tunes.delete,
        )
        self.list_voices = to_streamed_response_wrapper(
            fine_tunes.list_voices,
        )


class AsyncFineTunesResourceWithStreamingResponse:
    def __init__(self, fine_tunes: AsyncFineTunesResource) -> None:
        self._fine_tunes = fine_tunes

        self.create = async_to_streamed_response_wrapper(
            fine_tunes.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            fine_tunes.retrieve,
        )
        self.list = async_to_streamed_response_wrapper(
            fine_tunes.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            fine_tunes.delete,
        )
        self.list_voices = async_to_streamed_response_wrapper(
            fine_tunes.list_voices,
        )
