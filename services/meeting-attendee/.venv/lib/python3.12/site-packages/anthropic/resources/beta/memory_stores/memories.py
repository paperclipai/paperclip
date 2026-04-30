# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Any, List, Optional, cast
from itertools import chain
from typing_extensions import Literal

import httpx

from .... import _legacy_response
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ...._base_client import AsyncPaginator, make_request_options
from ....types.beta.memory_stores import (
    BetaManagedAgentsMemoryView,
    memory_list_params,
    memory_create_params,
    memory_delete_params,
    memory_update_params,
    memory_retrieve_params,
)
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.memory_stores.beta_managed_agents_memory import BetaManagedAgentsMemory
from ....types.beta.memory_stores.beta_managed_agents_memory_view import BetaManagedAgentsMemoryView
from ....types.beta.memory_stores.beta_managed_agents_deleted_memory import BetaManagedAgentsDeletedMemory
from ....types.beta.memory_stores.beta_managed_agents_memory_list_item import BetaManagedAgentsMemoryListItem
from ....types.beta.memory_stores.beta_managed_agents_precondition_param import BetaManagedAgentsPreconditionParam

__all__ = ["Memories", "AsyncMemories"]


class Memories(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> MemoriesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return MemoriesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> MemoriesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return MemoriesWithStreamingResponse(self)

    def create(
        self,
        memory_store_id: str,
        *,
        content: Optional[str],
        path: str,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemory:
        """
        CreateMemory

        Args:
          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._post(
            path_template("/v1/memory_stores/{memory_store_id}/memories?beta=true", memory_store_id=memory_store_id),
            body=maybe_transform(
                {
                    "content": content,
                    "path": path,
                },
                memory_create_params.MemoryCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform({"view": view}, memory_create_params.MemoryCreateParams),
            ),
            cast_to=BetaManagedAgentsMemory,
        )

    def retrieve(
        self,
        memory_id: str,
        *,
        memory_store_id: str,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemory:
        """
        GetMemory

        Args:
          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_id:
            raise ValueError(f"Expected a non-empty value for `memory_id` but received {memory_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._get(
            path_template(
                "/v1/memory_stores/{memory_store_id}/memories/{memory_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_id=memory_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform({"view": view}, memory_retrieve_params.MemoryRetrieveParams),
            ),
            cast_to=BetaManagedAgentsMemory,
        )

    def update(
        self,
        memory_id: str,
        *,
        memory_store_id: str,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        content: Optional[str] | Omit = omit,
        path: Optional[str] | Omit = omit,
        precondition: BetaManagedAgentsPreconditionParam | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemory:
        """
        UpdateMemory

        Args:
          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_id:
            raise ValueError(f"Expected a non-empty value for `memory_id` but received {memory_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._post(
            path_template(
                "/v1/memory_stores/{memory_store_id}/memories/{memory_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_id=memory_id,
            ),
            body=maybe_transform(
                {
                    "content": content,
                    "path": path,
                    "precondition": precondition,
                },
                memory_update_params.MemoryUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform({"view": view}, memory_update_params.MemoryUpdateParams),
            ),
            cast_to=BetaManagedAgentsMemory,
        )

    def list(
        self,
        memory_store_id: str,
        *,
        depth: int | Omit = omit,
        limit: int | Omit = omit,
        order: Literal["asc", "desc"] | Omit = omit,
        order_by: str | Omit = omit,
        page: str | Omit = omit,
        path_prefix: str | Omit = omit,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[BetaManagedAgentsMemoryListItem]:
        """
        ListMemories

        Args:
          depth: Query parameter for depth

          limit: Query parameter for limit

          order: Query parameter for order

          order_by: Query parameter for order_by

          page: Query parameter for page

          path_prefix: Optional path prefix filter (raw string-prefix match; include a trailing slash
              for directory-scoped lists). This value appears in request URLs. Do not include
              secrets or personally identifiable information.

          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._get_api_list(
            path_template("/v1/memory_stores/{memory_store_id}/memories?beta=true", memory_store_id=memory_store_id),
            page=SyncPageCursor[BetaManagedAgentsMemoryListItem],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "depth": depth,
                        "limit": limit,
                        "order": order,
                        "order_by": order_by,
                        "page": page,
                        "path_prefix": path_prefix,
                        "view": view,
                    },
                    memory_list_params.MemoryListParams,
                ),
            ),
            model=cast(
                Any, BetaManagedAgentsMemoryListItem
            ),  # Union types cannot be passed in as arguments in the type system
        )

    def delete(
        self,
        memory_id: str,
        *,
        memory_store_id: str,
        expected_content_sha256: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedMemory:
        """
        DeleteMemory

        Args:
          expected_content_sha256: Query parameter for expected_content_sha256

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_id:
            raise ValueError(f"Expected a non-empty value for `memory_id` but received {memory_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._delete(
            path_template(
                "/v1/memory_stores/{memory_store_id}/memories/{memory_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_id=memory_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {"expected_content_sha256": expected_content_sha256}, memory_delete_params.MemoryDeleteParams
                ),
            ),
            cast_to=BetaManagedAgentsDeletedMemory,
        )


class AsyncMemories(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncMemoriesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncMemoriesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncMemoriesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncMemoriesWithStreamingResponse(self)

    async def create(
        self,
        memory_store_id: str,
        *,
        content: Optional[str],
        path: str,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemory:
        """
        CreateMemory

        Args:
          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._post(
            path_template("/v1/memory_stores/{memory_store_id}/memories?beta=true", memory_store_id=memory_store_id),
            body=await async_maybe_transform(
                {
                    "content": content,
                    "path": path,
                },
                memory_create_params.MemoryCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform({"view": view}, memory_create_params.MemoryCreateParams),
            ),
            cast_to=BetaManagedAgentsMemory,
        )

    async def retrieve(
        self,
        memory_id: str,
        *,
        memory_store_id: str,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemory:
        """
        GetMemory

        Args:
          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_id:
            raise ValueError(f"Expected a non-empty value for `memory_id` but received {memory_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._get(
            path_template(
                "/v1/memory_stores/{memory_store_id}/memories/{memory_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_id=memory_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform({"view": view}, memory_retrieve_params.MemoryRetrieveParams),
            ),
            cast_to=BetaManagedAgentsMemory,
        )

    async def update(
        self,
        memory_id: str,
        *,
        memory_store_id: str,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        content: Optional[str] | Omit = omit,
        path: Optional[str] | Omit = omit,
        precondition: BetaManagedAgentsPreconditionParam | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemory:
        """
        UpdateMemory

        Args:
          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_id:
            raise ValueError(f"Expected a non-empty value for `memory_id` but received {memory_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._post(
            path_template(
                "/v1/memory_stores/{memory_store_id}/memories/{memory_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_id=memory_id,
            ),
            body=await async_maybe_transform(
                {
                    "content": content,
                    "path": path,
                    "precondition": precondition,
                },
                memory_update_params.MemoryUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform({"view": view}, memory_update_params.MemoryUpdateParams),
            ),
            cast_to=BetaManagedAgentsMemory,
        )

    def list(
        self,
        memory_store_id: str,
        *,
        depth: int | Omit = omit,
        limit: int | Omit = omit,
        order: Literal["asc", "desc"] | Omit = omit,
        order_by: str | Omit = omit,
        page: str | Omit = omit,
        path_prefix: str | Omit = omit,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[BetaManagedAgentsMemoryListItem, AsyncPageCursor[BetaManagedAgentsMemoryListItem]]:
        """
        ListMemories

        Args:
          depth: Query parameter for depth

          limit: Query parameter for limit

          order: Query parameter for order

          order_by: Query parameter for order_by

          page: Query parameter for page

          path_prefix: Optional path prefix filter (raw string-prefix match; include a trailing slash
              for directory-scoped lists). This value appears in request URLs. Do not include
              secrets or personally identifiable information.

          view: Query parameter for view

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._get_api_list(
            path_template("/v1/memory_stores/{memory_store_id}/memories?beta=true", memory_store_id=memory_store_id),
            page=AsyncPageCursor[BetaManagedAgentsMemoryListItem],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "depth": depth,
                        "limit": limit,
                        "order": order,
                        "order_by": order_by,
                        "page": page,
                        "path_prefix": path_prefix,
                        "view": view,
                    },
                    memory_list_params.MemoryListParams,
                ),
            ),
            model=cast(
                Any, BetaManagedAgentsMemoryListItem
            ),  # Union types cannot be passed in as arguments in the type system
        )

    async def delete(
        self,
        memory_id: str,
        *,
        memory_store_id: str,
        expected_content_sha256: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedMemory:
        """
        DeleteMemory

        Args:
          expected_content_sha256: Query parameter for expected_content_sha256

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_id:
            raise ValueError(f"Expected a non-empty value for `memory_id` but received {memory_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._delete(
            path_template(
                "/v1/memory_stores/{memory_store_id}/memories/{memory_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_id=memory_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform(
                    {"expected_content_sha256": expected_content_sha256}, memory_delete_params.MemoryDeleteParams
                ),
            ),
            cast_to=BetaManagedAgentsDeletedMemory,
        )


class MemoriesWithRawResponse:
    def __init__(self, memories: Memories) -> None:
        self._memories = memories

        self.create = _legacy_response.to_raw_response_wrapper(
            memories.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            memories.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            memories.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            memories.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            memories.delete,
        )


class AsyncMemoriesWithRawResponse:
    def __init__(self, memories: AsyncMemories) -> None:
        self._memories = memories

        self.create = _legacy_response.async_to_raw_response_wrapper(
            memories.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            memories.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            memories.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            memories.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            memories.delete,
        )


class MemoriesWithStreamingResponse:
    def __init__(self, memories: Memories) -> None:
        self._memories = memories

        self.create = to_streamed_response_wrapper(
            memories.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            memories.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            memories.update,
        )
        self.list = to_streamed_response_wrapper(
            memories.list,
        )
        self.delete = to_streamed_response_wrapper(
            memories.delete,
        )


class AsyncMemoriesWithStreamingResponse:
    def __init__(self, memories: AsyncMemories) -> None:
        self._memories = memories

        self.create = async_to_streamed_response_wrapper(
            memories.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            memories.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            memories.update,
        )
        self.list = async_to_streamed_response_wrapper(
            memories.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            memories.delete,
        )
