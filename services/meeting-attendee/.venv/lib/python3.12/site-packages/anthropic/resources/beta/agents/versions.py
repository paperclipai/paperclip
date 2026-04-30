# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from itertools import chain

import httpx

from .... import _legacy_response
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ...._base_client import AsyncPaginator, make_request_options
from ....types.beta.agents import version_list_params
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.beta_managed_agents_agent import BetaManagedAgentsAgent

__all__ = ["Versions", "AsyncVersions"]


class Versions(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> VersionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return VersionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> VersionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return VersionsWithStreamingResponse(self)

    def list(
        self,
        agent_id: str,
        *,
        limit: int | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[BetaManagedAgentsAgent]:
        """List Agent Versions

        Args:
          limit: Maximum results per page.

        Default 20, maximum 100.

          page: Opaque pagination cursor.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
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
            path_template("/v1/agents/{agent_id}/versions?beta=true", agent_id=agent_id),
            page=SyncPageCursor[BetaManagedAgentsAgent],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "page": page,
                    },
                    version_list_params.VersionListParams,
                ),
            ),
            model=BetaManagedAgentsAgent,
        )


class AsyncVersions(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncVersionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncVersionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncVersionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncVersionsWithStreamingResponse(self)

    def list(
        self,
        agent_id: str,
        *,
        limit: int | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[BetaManagedAgentsAgent, AsyncPageCursor[BetaManagedAgentsAgent]]:
        """List Agent Versions

        Args:
          limit: Maximum results per page.

        Default 20, maximum 100.

          page: Opaque pagination cursor.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
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
            path_template("/v1/agents/{agent_id}/versions?beta=true", agent_id=agent_id),
            page=AsyncPageCursor[BetaManagedAgentsAgent],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "page": page,
                    },
                    version_list_params.VersionListParams,
                ),
            ),
            model=BetaManagedAgentsAgent,
        )


class VersionsWithRawResponse:
    def __init__(self, versions: Versions) -> None:
        self._versions = versions

        self.list = _legacy_response.to_raw_response_wrapper(
            versions.list,
        )


class AsyncVersionsWithRawResponse:
    def __init__(self, versions: AsyncVersions) -> None:
        self._versions = versions

        self.list = _legacy_response.async_to_raw_response_wrapper(
            versions.list,
        )


class VersionsWithStreamingResponse:
    def __init__(self, versions: Versions) -> None:
        self._versions = versions

        self.list = to_streamed_response_wrapper(
            versions.list,
        )


class AsyncVersionsWithStreamingResponse:
    def __init__(self, versions: AsyncVersions) -> None:
        self._versions = versions

        self.list = async_to_streamed_response_wrapper(
            versions.list,
        )
