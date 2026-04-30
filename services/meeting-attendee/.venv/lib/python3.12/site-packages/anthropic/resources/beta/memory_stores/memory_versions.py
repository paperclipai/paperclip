# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Union
from datetime import datetime
from itertools import chain

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
    BetaManagedAgentsMemoryVersionOperation,
    memory_version_list_params,
    memory_version_retrieve_params,
)
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.memory_stores.beta_managed_agents_memory_view import BetaManagedAgentsMemoryView
from ....types.beta.memory_stores.beta_managed_agents_memory_version import BetaManagedAgentsMemoryVersion
from ....types.beta.memory_stores.beta_managed_agents_memory_version_operation import (
    BetaManagedAgentsMemoryVersionOperation,
)

__all__ = ["MemoryVersions", "AsyncMemoryVersions"]


class MemoryVersions(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> MemoryVersionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return MemoryVersionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> MemoryVersionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return MemoryVersionsWithStreamingResponse(self)

    def retrieve(
        self,
        memory_version_id: str,
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
    ) -> BetaManagedAgentsMemoryVersion:
        """
        GetMemoryVersion

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
        if not memory_version_id:
            raise ValueError(f"Expected a non-empty value for `memory_version_id` but received {memory_version_id!r}")
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
                "/v1/memory_stores/{memory_store_id}/memory_versions/{memory_version_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_version_id=memory_version_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform({"view": view}, memory_version_retrieve_params.MemoryVersionRetrieveParams),
            ),
            cast_to=BetaManagedAgentsMemoryVersion,
        )

    def list(
        self,
        memory_store_id: str,
        *,
        api_key_id: str | Omit = omit,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        limit: int | Omit = omit,
        memory_id: str | Omit = omit,
        operation: BetaManagedAgentsMemoryVersionOperation | Omit = omit,
        page: str | Omit = omit,
        session_id: str | Omit = omit,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[BetaManagedAgentsMemoryVersion]:
        """
        ListMemoryVersions

        Args:
          api_key_id: Query parameter for api_key_id

          created_at_gte: Return versions created at or after this time (inclusive).

          created_at_lte: Return versions created at or before this time (inclusive).

          limit: Query parameter for limit

          memory_id: Query parameter for memory_id

          operation: Query parameter for operation

          page: Query parameter for page

          session_id: Query parameter for session_id

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
            path_template(
                "/v1/memory_stores/{memory_store_id}/memory_versions?beta=true", memory_store_id=memory_store_id
            ),
            page=SyncPageCursor[BetaManagedAgentsMemoryVersion],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "api_key_id": api_key_id,
                        "created_at_gte": created_at_gte,
                        "created_at_lte": created_at_lte,
                        "limit": limit,
                        "memory_id": memory_id,
                        "operation": operation,
                        "page": page,
                        "session_id": session_id,
                        "view": view,
                    },
                    memory_version_list_params.MemoryVersionListParams,
                ),
            ),
            model=BetaManagedAgentsMemoryVersion,
        )

    def redact(
        self,
        memory_version_id: str,
        *,
        memory_store_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryVersion:
        """
        RedactMemoryVersion

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_version_id:
            raise ValueError(f"Expected a non-empty value for `memory_version_id` but received {memory_version_id!r}")
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
                "/v1/memory_stores/{memory_store_id}/memory_versions/{memory_version_id}/redact?beta=true",
                memory_store_id=memory_store_id,
                memory_version_id=memory_version_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryVersion,
        )


class AsyncMemoryVersions(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncMemoryVersionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncMemoryVersionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncMemoryVersionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncMemoryVersionsWithStreamingResponse(self)

    async def retrieve(
        self,
        memory_version_id: str,
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
    ) -> BetaManagedAgentsMemoryVersion:
        """
        GetMemoryVersion

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
        if not memory_version_id:
            raise ValueError(f"Expected a non-empty value for `memory_version_id` but received {memory_version_id!r}")
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
                "/v1/memory_stores/{memory_store_id}/memory_versions/{memory_version_id}?beta=true",
                memory_store_id=memory_store_id,
                memory_version_id=memory_version_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform(
                    {"view": view}, memory_version_retrieve_params.MemoryVersionRetrieveParams
                ),
            ),
            cast_to=BetaManagedAgentsMemoryVersion,
        )

    def list(
        self,
        memory_store_id: str,
        *,
        api_key_id: str | Omit = omit,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        limit: int | Omit = omit,
        memory_id: str | Omit = omit,
        operation: BetaManagedAgentsMemoryVersionOperation | Omit = omit,
        page: str | Omit = omit,
        session_id: str | Omit = omit,
        view: BetaManagedAgentsMemoryView | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[BetaManagedAgentsMemoryVersion, AsyncPageCursor[BetaManagedAgentsMemoryVersion]]:
        """
        ListMemoryVersions

        Args:
          api_key_id: Query parameter for api_key_id

          created_at_gte: Return versions created at or after this time (inclusive).

          created_at_lte: Return versions created at or before this time (inclusive).

          limit: Query parameter for limit

          memory_id: Query parameter for memory_id

          operation: Query parameter for operation

          page: Query parameter for page

          session_id: Query parameter for session_id

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
            path_template(
                "/v1/memory_stores/{memory_store_id}/memory_versions?beta=true", memory_store_id=memory_store_id
            ),
            page=AsyncPageCursor[BetaManagedAgentsMemoryVersion],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "api_key_id": api_key_id,
                        "created_at_gte": created_at_gte,
                        "created_at_lte": created_at_lte,
                        "limit": limit,
                        "memory_id": memory_id,
                        "operation": operation,
                        "page": page,
                        "session_id": session_id,
                        "view": view,
                    },
                    memory_version_list_params.MemoryVersionListParams,
                ),
            ),
            model=BetaManagedAgentsMemoryVersion,
        )

    async def redact(
        self,
        memory_version_id: str,
        *,
        memory_store_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsMemoryVersion:
        """
        RedactMemoryVersion

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not memory_store_id:
            raise ValueError(f"Expected a non-empty value for `memory_store_id` but received {memory_store_id!r}")
        if not memory_version_id:
            raise ValueError(f"Expected a non-empty value for `memory_version_id` but received {memory_version_id!r}")
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
                "/v1/memory_stores/{memory_store_id}/memory_versions/{memory_version_id}/redact?beta=true",
                memory_store_id=memory_store_id,
                memory_version_id=memory_version_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsMemoryVersion,
        )


class MemoryVersionsWithRawResponse:
    def __init__(self, memory_versions: MemoryVersions) -> None:
        self._memory_versions = memory_versions

        self.retrieve = _legacy_response.to_raw_response_wrapper(
            memory_versions.retrieve,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            memory_versions.list,
        )
        self.redact = _legacy_response.to_raw_response_wrapper(
            memory_versions.redact,
        )


class AsyncMemoryVersionsWithRawResponse:
    def __init__(self, memory_versions: AsyncMemoryVersions) -> None:
        self._memory_versions = memory_versions

        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            memory_versions.retrieve,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            memory_versions.list,
        )
        self.redact = _legacy_response.async_to_raw_response_wrapper(
            memory_versions.redact,
        )


class MemoryVersionsWithStreamingResponse:
    def __init__(self, memory_versions: MemoryVersions) -> None:
        self._memory_versions = memory_versions

        self.retrieve = to_streamed_response_wrapper(
            memory_versions.retrieve,
        )
        self.list = to_streamed_response_wrapper(
            memory_versions.list,
        )
        self.redact = to_streamed_response_wrapper(
            memory_versions.redact,
        )


class AsyncMemoryVersionsWithStreamingResponse:
    def __init__(self, memory_versions: AsyncMemoryVersions) -> None:
        self._memory_versions = memory_versions

        self.retrieve = async_to_streamed_response_wrapper(
            memory_versions.retrieve,
        )
        self.list = async_to_streamed_response_wrapper(
            memory_versions.list,
        )
        self.redact = async_to_streamed_response_wrapper(
            memory_versions.redact,
        )
