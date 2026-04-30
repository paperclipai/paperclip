# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Optional
from datetime import datetime
from itertools import chain

import httpx

from .... import _legacy_response
from .memories import (
    Memories,
    AsyncMemories,
    MemoriesWithRawResponse,
    AsyncMemoriesWithRawResponse,
    MemoriesWithStreamingResponse,
    AsyncMemoriesWithStreamingResponse,
)
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ....types.beta import memory_store_list_params, memory_store_create_params, memory_store_update_params
from ...._base_client import AsyncPaginator, make_request_options
from .memory_versions import (
    MemoryVersions,
    AsyncMemoryVersions,
    MemoryVersionsWithRawResponse,
    AsyncMemoryVersionsWithRawResponse,
    MemoryVersionsWithStreamingResponse,
    AsyncMemoryVersionsWithStreamingResponse,
)
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.beta_managed_agents_memory_store import BetaManagedAgentsMemoryStore
from ....types.beta.beta_managed_agents_deleted_memory_store import BetaManagedAgentsDeletedMemoryStore

__all__ = ["MemoryStores", "AsyncMemoryStores"]


class MemoryStores(SyncAPIResource):
    @cached_property
    def memories(self) -> Memories:
        return Memories(self._client)

    @cached_property
    def memory_versions(self) -> MemoryVersions:
        return MemoryVersions(self._client)

    @cached_property
    def with_raw_response(self) -> MemoryStoresWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return MemoryStoresWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> MemoryStoresWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return MemoryStoresWithStreamingResponse(self)

    def create(
        self,
        *,
        name: str,
        description: str | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """
        CreateMemoryStore

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
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
            "/v1/memory_stores?beta=true",
            body=maybe_transform(
                {
                    "name": name,
                    "description": description,
                    "metadata": metadata,
                },
                memory_store_create_params.MemoryStoreCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )

    def retrieve(
        self,
        memory_store_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """
        GetMemoryStore

        Args:
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
        return self._get(
            path_template("/v1/memory_stores/{memory_store_id}?beta=true", memory_store_id=memory_store_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )

    def update(
        self,
        memory_store_id: str,
        *,
        description: Optional[str] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        name: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """UpdateMemoryStore

        Args:
          metadata: Metadata patch.

        Set a key to a string to upsert it, or to null to delete it.
              Omit the field to preserve. The stored bag is limited to 16 keys (up to 64 chars
              each) with values up to 512 chars.

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
            path_template("/v1/memory_stores/{memory_store_id}?beta=true", memory_store_id=memory_store_id),
            body=maybe_transform(
                {
                    "description": description,
                    "metadata": metadata,
                    "name": name,
                },
                memory_store_update_params.MemoryStoreUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )

    def list(
        self,
        *,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        include_archived: bool | Omit = omit,
        limit: int | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[BetaManagedAgentsMemoryStore]:
        """
        ListMemoryStores

        Args:
          created_at_gte: Return stores created at or after this time (inclusive).

          created_at_lte: Return stores created at or before this time (inclusive).

          include_archived: Query parameter for include_archived

          limit: Query parameter for limit

          page: Query parameter for page

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
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
            "/v1/memory_stores?beta=true",
            page=SyncPageCursor[BetaManagedAgentsMemoryStore],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "created_at_gte": created_at_gte,
                        "created_at_lte": created_at_lte,
                        "include_archived": include_archived,
                        "limit": limit,
                        "page": page,
                    },
                    memory_store_list_params.MemoryStoreListParams,
                ),
            ),
            model=BetaManagedAgentsMemoryStore,
        )

    def delete(
        self,
        memory_store_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedMemoryStore:
        """
        DeleteMemoryStore

        Args:
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
        return self._delete(
            path_template("/v1/memory_stores/{memory_store_id}?beta=true", memory_store_id=memory_store_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedMemoryStore,
        )

    def archive(
        self,
        memory_store_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """
        ArchiveMemoryStore

        Args:
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
            path_template("/v1/memory_stores/{memory_store_id}/archive?beta=true", memory_store_id=memory_store_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )


class AsyncMemoryStores(AsyncAPIResource):
    @cached_property
    def memories(self) -> AsyncMemories:
        return AsyncMemories(self._client)

    @cached_property
    def memory_versions(self) -> AsyncMemoryVersions:
        return AsyncMemoryVersions(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncMemoryStoresWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncMemoryStoresWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncMemoryStoresWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncMemoryStoresWithStreamingResponse(self)

    async def create(
        self,
        *,
        name: str,
        description: str | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """
        CreateMemoryStore

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
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
            "/v1/memory_stores?beta=true",
            body=await async_maybe_transform(
                {
                    "name": name,
                    "description": description,
                    "metadata": metadata,
                },
                memory_store_create_params.MemoryStoreCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )

    async def retrieve(
        self,
        memory_store_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """
        GetMemoryStore

        Args:
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
        return await self._get(
            path_template("/v1/memory_stores/{memory_store_id}?beta=true", memory_store_id=memory_store_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )

    async def update(
        self,
        memory_store_id: str,
        *,
        description: Optional[str] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        name: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """UpdateMemoryStore

        Args:
          metadata: Metadata patch.

        Set a key to a string to upsert it, or to null to delete it.
              Omit the field to preserve. The stored bag is limited to 16 keys (up to 64 chars
              each) with values up to 512 chars.

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
            path_template("/v1/memory_stores/{memory_store_id}?beta=true", memory_store_id=memory_store_id),
            body=await async_maybe_transform(
                {
                    "description": description,
                    "metadata": metadata,
                    "name": name,
                },
                memory_store_update_params.MemoryStoreUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )

    def list(
        self,
        *,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        include_archived: bool | Omit = omit,
        limit: int | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[BetaManagedAgentsMemoryStore, AsyncPageCursor[BetaManagedAgentsMemoryStore]]:
        """
        ListMemoryStores

        Args:
          created_at_gte: Return stores created at or after this time (inclusive).

          created_at_lte: Return stores created at or before this time (inclusive).

          include_archived: Query parameter for include_archived

          limit: Query parameter for limit

          page: Query parameter for page

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
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
            "/v1/memory_stores?beta=true",
            page=AsyncPageCursor[BetaManagedAgentsMemoryStore],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "created_at_gte": created_at_gte,
                        "created_at_lte": created_at_lte,
                        "include_archived": include_archived,
                        "limit": limit,
                        "page": page,
                    },
                    memory_store_list_params.MemoryStoreListParams,
                ),
            ),
            model=BetaManagedAgentsMemoryStore,
        )

    async def delete(
        self,
        memory_store_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedMemoryStore:
        """
        DeleteMemoryStore

        Args:
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
        return await self._delete(
            path_template("/v1/memory_stores/{memory_store_id}?beta=true", memory_store_id=memory_store_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedMemoryStore,
        )

    async def archive(
        self,
        memory_store_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryStore:
        """
        ArchiveMemoryStore

        Args:
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
            path_template("/v1/memory_stores/{memory_store_id}/archive?beta=true", memory_store_id=memory_store_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryStore,
        )


class MemoryStoresWithRawResponse:
    def __init__(self, memory_stores: MemoryStores) -> None:
        self._memory_stores = memory_stores

        self.create = _legacy_response.to_raw_response_wrapper(
            memory_stores.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            memory_stores.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            memory_stores.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            memory_stores.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            memory_stores.delete,
        )
        self.archive = _legacy_response.to_raw_response_wrapper(
            memory_stores.archive,
        )

    @cached_property
    def memories(self) -> MemoriesWithRawResponse:
        return MemoriesWithRawResponse(self._memory_stores.memories)

    @cached_property
    def memory_versions(self) -> MemoryVersionsWithRawResponse:
        return MemoryVersionsWithRawResponse(self._memory_stores.memory_versions)


class AsyncMemoryStoresWithRawResponse:
    def __init__(self, memory_stores: AsyncMemoryStores) -> None:
        self._memory_stores = memory_stores

        self.create = _legacy_response.async_to_raw_response_wrapper(
            memory_stores.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            memory_stores.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            memory_stores.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            memory_stores.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            memory_stores.delete,
        )
        self.archive = _legacy_response.async_to_raw_response_wrapper(
            memory_stores.archive,
        )

    @cached_property
    def memories(self) -> AsyncMemoriesWithRawResponse:
        return AsyncMemoriesWithRawResponse(self._memory_stores.memories)

    @cached_property
    def memory_versions(self) -> AsyncMemoryVersionsWithRawResponse:
        return AsyncMemoryVersionsWithRawResponse(self._memory_stores.memory_versions)


class MemoryStoresWithStreamingResponse:
    def __init__(self, memory_stores: MemoryStores) -> None:
        self._memory_stores = memory_stores

        self.create = to_streamed_response_wrapper(
            memory_stores.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            memory_stores.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            memory_stores.update,
        )
        self.list = to_streamed_response_wrapper(
            memory_stores.list,
        )
        self.delete = to_streamed_response_wrapper(
            memory_stores.delete,
        )
        self.archive = to_streamed_response_wrapper(
            memory_stores.archive,
        )

    @cached_property
    def memories(self) -> MemoriesWithStreamingResponse:
        return MemoriesWithStreamingResponse(self._memory_stores.memories)

    @cached_property
    def memory_versions(self) -> MemoryVersionsWithStreamingResponse:
        return MemoryVersionsWithStreamingResponse(self._memory_stores.memory_versions)


class AsyncMemoryStoresWithStreamingResponse:
    def __init__(self, memory_stores: AsyncMemoryStores) -> None:
        self._memory_stores = memory_stores

        self.create = async_to_streamed_response_wrapper(
            memory_stores.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            memory_stores.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            memory_stores.update,
        )
        self.list = async_to_streamed_response_wrapper(
            memory_stores.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            memory_stores.delete,
        )
        self.archive = async_to_streamed_response_wrapper(
            memory_stores.archive,
        )

    @cached_property
    def memories(self) -> AsyncMemoriesWithStreamingResponse:
        return AsyncMemoriesWithStreamingResponse(self._memory_stores.memories)

    @cached_property
    def memory_versions(self) -> AsyncMemoryVersionsWithStreamingResponse:
        return AsyncMemoryVersionsWithStreamingResponse(self._memory_stores.memory_versions)
