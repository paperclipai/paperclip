# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable, Optional

import httpx

from ..types import pronunciation_dict_list_params, pronunciation_dict_create_params, pronunciation_dict_update_params
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
from .._base_client import AsyncPaginator, make_request_options
from ..types.pronunciation_dict import PronunciationDict
from ..types.pronunciation_dict_item_param import PronunciationDictItemParam

__all__ = ["PronunciationDictsResource", "AsyncPronunciationDictsResource"]


class PronunciationDictsResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> PronunciationDictsResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return PronunciationDictsResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> PronunciationDictsResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return PronunciationDictsResourceWithStreamingResponse(self)

    def create(
        self,
        *,
        name: str,
        items: Optional[Iterable[PronunciationDictItemParam]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> PronunciationDict:
        """
        Create a new pronunciation dictionary

        Args:
          name: Name for the new pronunciation dictionary

          items: Optional initial list of pronunciation mappings

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._post(
            "/pronunciation-dicts/",
            body=maybe_transform(
                {
                    "name": name,
                    "items": items,
                },
                pronunciation_dict_create_params.PronunciationDictCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=PronunciationDict,
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
    ) -> PronunciationDict:
        """
        Retrieve a specific pronunciation dictionary by ID

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._get(
            f"/pronunciation-dicts/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=PronunciationDict,
        )

    def update(
        self,
        id: str,
        *,
        items: Optional[Iterable[PronunciationDictItemParam]] | Omit = omit,
        name: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> PronunciationDict:
        """
        Update a pronunciation dictionary

        Args:
          items: Updated list of pronunciation mappings

          name: New name for the pronunciation dictionary

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._patch(
            f"/pronunciation-dicts/{id}",
            body=maybe_transform(
                {
                    "items": items,
                    "name": name,
                },
                pronunciation_dict_update_params.PronunciationDictUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=PronunciationDict,
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
    ) -> SyncCursorIDPage[PronunciationDict]:
        """
        List all pronunciation dictionaries for the authenticated user

        Args:
          ending_before: A cursor to use in pagination. `ending_before` is a dictionary ID that defines
              your place in the list. For example, if you make a request and receive 20
              objects, starting with `dict_abc123`, your subsequent call can include
              `ending_before=dict_abc123` to fetch the previous page of the list.

          limit: The number of dictionaries to return per page, ranging between 1 and 100.

          starting_after: A cursor to use in pagination. `starting_after` is a dictionary ID that defines
              your place in the list. For example, if you make a request and receive 20
              objects, ending with `dict_abc123`, your subsequent call can include
              `starting_after=dict_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/pronunciation-dicts/",
            page=SyncCursorIDPage[PronunciationDict],
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
                    pronunciation_dict_list_params.PronunciationDictListParams,
                ),
            ),
            model=PronunciationDict,
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
        Delete a pronunciation dictionary

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
            f"/pronunciation-dicts/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )


class AsyncPronunciationDictsResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncPronunciationDictsResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncPronunciationDictsResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncPronunciationDictsResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncPronunciationDictsResourceWithStreamingResponse(self)

    async def create(
        self,
        *,
        name: str,
        items: Optional[Iterable[PronunciationDictItemParam]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> PronunciationDict:
        """
        Create a new pronunciation dictionary

        Args:
          name: Name for the new pronunciation dictionary

          items: Optional initial list of pronunciation mappings

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return await self._post(
            "/pronunciation-dicts/",
            body=await async_maybe_transform(
                {
                    "name": name,
                    "items": items,
                },
                pronunciation_dict_create_params.PronunciationDictCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=PronunciationDict,
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
    ) -> PronunciationDict:
        """
        Retrieve a specific pronunciation dictionary by ID

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return await self._get(
            f"/pronunciation-dicts/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=PronunciationDict,
        )

    async def update(
        self,
        id: str,
        *,
        items: Optional[Iterable[PronunciationDictItemParam]] | Omit = omit,
        name: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> PronunciationDict:
        """
        Update a pronunciation dictionary

        Args:
          items: Updated list of pronunciation mappings

          name: New name for the pronunciation dictionary

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return await self._patch(
            f"/pronunciation-dicts/{id}",
            body=await async_maybe_transform(
                {
                    "items": items,
                    "name": name,
                },
                pronunciation_dict_update_params.PronunciationDictUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=PronunciationDict,
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
    ) -> AsyncPaginator[PronunciationDict, AsyncCursorIDPage[PronunciationDict]]:
        """
        List all pronunciation dictionaries for the authenticated user

        Args:
          ending_before: A cursor to use in pagination. `ending_before` is a dictionary ID that defines
              your place in the list. For example, if you make a request and receive 20
              objects, starting with `dict_abc123`, your subsequent call can include
              `ending_before=dict_abc123` to fetch the previous page of the list.

          limit: The number of dictionaries to return per page, ranging between 1 and 100.

          starting_after: A cursor to use in pagination. `starting_after` is a dictionary ID that defines
              your place in the list. For example, if you make a request and receive 20
              objects, ending with `dict_abc123`, your subsequent call can include
              `starting_after=dict_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/pronunciation-dicts/",
            page=AsyncCursorIDPage[PronunciationDict],
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
                    pronunciation_dict_list_params.PronunciationDictListParams,
                ),
            ),
            model=PronunciationDict,
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
        Delete a pronunciation dictionary

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
            f"/pronunciation-dicts/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )


class PronunciationDictsResourceWithRawResponse:
    def __init__(self, pronunciation_dicts: PronunciationDictsResource) -> None:
        self._pronunciation_dicts = pronunciation_dicts

        self.create = to_raw_response_wrapper(
            pronunciation_dicts.create,
        )
        self.retrieve = to_raw_response_wrapper(
            pronunciation_dicts.retrieve,
        )
        self.update = to_raw_response_wrapper(
            pronunciation_dicts.update,
        )
        self.list = to_raw_response_wrapper(
            pronunciation_dicts.list,
        )
        self.delete = to_raw_response_wrapper(
            pronunciation_dicts.delete,
        )


class AsyncPronunciationDictsResourceWithRawResponse:
    def __init__(self, pronunciation_dicts: AsyncPronunciationDictsResource) -> None:
        self._pronunciation_dicts = pronunciation_dicts

        self.create = async_to_raw_response_wrapper(
            pronunciation_dicts.create,
        )
        self.retrieve = async_to_raw_response_wrapper(
            pronunciation_dicts.retrieve,
        )
        self.update = async_to_raw_response_wrapper(
            pronunciation_dicts.update,
        )
        self.list = async_to_raw_response_wrapper(
            pronunciation_dicts.list,
        )
        self.delete = async_to_raw_response_wrapper(
            pronunciation_dicts.delete,
        )


class PronunciationDictsResourceWithStreamingResponse:
    def __init__(self, pronunciation_dicts: PronunciationDictsResource) -> None:
        self._pronunciation_dicts = pronunciation_dicts

        self.create = to_streamed_response_wrapper(
            pronunciation_dicts.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            pronunciation_dicts.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            pronunciation_dicts.update,
        )
        self.list = to_streamed_response_wrapper(
            pronunciation_dicts.list,
        )
        self.delete = to_streamed_response_wrapper(
            pronunciation_dicts.delete,
        )


class AsyncPronunciationDictsResourceWithStreamingResponse:
    def __init__(self, pronunciation_dicts: AsyncPronunciationDictsResource) -> None:
        self._pronunciation_dicts = pronunciation_dicts

        self.create = async_to_streamed_response_wrapper(
            pronunciation_dicts.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            pronunciation_dicts.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            pronunciation_dicts.update,
        )
        self.list = async_to_streamed_response_wrapper(
            pronunciation_dicts.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            pronunciation_dicts.delete,
        )
