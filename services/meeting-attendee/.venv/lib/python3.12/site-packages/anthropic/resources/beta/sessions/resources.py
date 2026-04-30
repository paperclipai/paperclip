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
from ....types.beta.sessions import resource_add_params, resource_list_params, resource_update_params
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.sessions.resource_update_response import ResourceUpdateResponse
from ....types.beta.sessions.resource_retrieve_response import ResourceRetrieveResponse
from ....types.beta.sessions.beta_managed_agents_file_resource import BetaManagedAgentsFileResource
from ....types.beta.sessions.beta_managed_agents_session_resource import BetaManagedAgentsSessionResource
from ....types.beta.sessions.beta_managed_agents_delete_session_resource import BetaManagedAgentsDeleteSessionResource

__all__ = ["Resources", "AsyncResources"]


class Resources(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> ResourcesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return ResourcesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> ResourcesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return ResourcesWithStreamingResponse(self)

    def retrieve(
        self,
        resource_id: str,
        *,
        session_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> ResourceRetrieveResponse:
        """
        Get Session Resource

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
        if not resource_id:
            raise ValueError(f"Expected a non-empty value for `resource_id` but received {resource_id!r}")
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
        return cast(
            ResourceRetrieveResponse,
            self._get(
                path_template(
                    "/v1/sessions/{session_id}/resources/{resource_id}?beta=true",
                    session_id=session_id,
                    resource_id=resource_id,
                ),
                options=make_request_options(
                    extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
                ),
                cast_to=cast(
                    Any, ResourceRetrieveResponse
                ),  # Union types cannot be passed in as arguments in the type system
            ),
        )

    def update(
        self,
        resource_id: str,
        *,
        session_id: str,
        authorization_token: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> ResourceUpdateResponse:
        """
        Update Session Resource

        Args:
          authorization_token: New authorization token for the resource. Currently only `github_repository`
              resources support token rotation.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
        if not resource_id:
            raise ValueError(f"Expected a non-empty value for `resource_id` but received {resource_id!r}")
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
        return cast(
            ResourceUpdateResponse,
            self._post(
                path_template(
                    "/v1/sessions/{session_id}/resources/{resource_id}?beta=true",
                    session_id=session_id,
                    resource_id=resource_id,
                ),
                body=maybe_transform(
                    {"authorization_token": authorization_token}, resource_update_params.ResourceUpdateParams
                ),
                options=make_request_options(
                    extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
                ),
                cast_to=cast(
                    Any, ResourceUpdateResponse
                ),  # Union types cannot be passed in as arguments in the type system
            ),
        )

    def list(
        self,
        session_id: str,
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
    ) -> SyncPageCursor[BetaManagedAgentsSessionResource]:
        """
        List Session Resources

        Args:
          limit: Maximum number of resources to return per page (max 1000). If omitted, returns
              all resources.

          page: Opaque cursor from a previous response's next_page field.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
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
            path_template("/v1/sessions/{session_id}/resources?beta=true", session_id=session_id),
            page=SyncPageCursor[BetaManagedAgentsSessionResource],
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
                    resource_list_params.ResourceListParams,
                ),
            ),
            model=cast(
                Any, BetaManagedAgentsSessionResource
            ),  # Union types cannot be passed in as arguments in the type system
        )

    def delete(
        self,
        resource_id: str,
        *,
        session_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeleteSessionResource:
        """
        Delete Session Resource

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
        if not resource_id:
            raise ValueError(f"Expected a non-empty value for `resource_id` but received {resource_id!r}")
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
                "/v1/sessions/{session_id}/resources/{resource_id}?beta=true",
                session_id=session_id,
                resource_id=resource_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeleteSessionResource,
        )

    def add(
        self,
        session_id: str,
        *,
        file_id: str,
        type: Literal["file"],
        mount_path: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsFileResource:
        """
        Add Session Resource

        Args:
          file_id: ID of a previously uploaded file.

          mount_path: Mount path in the container. Defaults to `/mnt/session/uploads/<file_id>`.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
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
            path_template("/v1/sessions/{session_id}/resources?beta=true", session_id=session_id),
            body=maybe_transform(
                {
                    "file_id": file_id,
                    "type": type,
                    "mount_path": mount_path,
                },
                resource_add_params.ResourceAddParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsFileResource,
        )


class AsyncResources(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncResourcesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncResourcesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncResourcesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncResourcesWithStreamingResponse(self)

    async def retrieve(
        self,
        resource_id: str,
        *,
        session_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> ResourceRetrieveResponse:
        """
        Get Session Resource

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
        if not resource_id:
            raise ValueError(f"Expected a non-empty value for `resource_id` but received {resource_id!r}")
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
        return cast(
            ResourceRetrieveResponse,
            await self._get(
                path_template(
                    "/v1/sessions/{session_id}/resources/{resource_id}?beta=true",
                    session_id=session_id,
                    resource_id=resource_id,
                ),
                options=make_request_options(
                    extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
                ),
                cast_to=cast(
                    Any, ResourceRetrieveResponse
                ),  # Union types cannot be passed in as arguments in the type system
            ),
        )

    async def update(
        self,
        resource_id: str,
        *,
        session_id: str,
        authorization_token: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> ResourceUpdateResponse:
        """
        Update Session Resource

        Args:
          authorization_token: New authorization token for the resource. Currently only `github_repository`
              resources support token rotation.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
        if not resource_id:
            raise ValueError(f"Expected a non-empty value for `resource_id` but received {resource_id!r}")
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
        return cast(
            ResourceUpdateResponse,
            await self._post(
                path_template(
                    "/v1/sessions/{session_id}/resources/{resource_id}?beta=true",
                    session_id=session_id,
                    resource_id=resource_id,
                ),
                body=await async_maybe_transform(
                    {"authorization_token": authorization_token}, resource_update_params.ResourceUpdateParams
                ),
                options=make_request_options(
                    extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
                ),
                cast_to=cast(
                    Any, ResourceUpdateResponse
                ),  # Union types cannot be passed in as arguments in the type system
            ),
        )

    def list(
        self,
        session_id: str,
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
    ) -> AsyncPaginator[BetaManagedAgentsSessionResource, AsyncPageCursor[BetaManagedAgentsSessionResource]]:
        """
        List Session Resources

        Args:
          limit: Maximum number of resources to return per page (max 1000). If omitted, returns
              all resources.

          page: Opaque cursor from a previous response's next_page field.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
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
            path_template("/v1/sessions/{session_id}/resources?beta=true", session_id=session_id),
            page=AsyncPageCursor[BetaManagedAgentsSessionResource],
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
                    resource_list_params.ResourceListParams,
                ),
            ),
            model=cast(
                Any, BetaManagedAgentsSessionResource
            ),  # Union types cannot be passed in as arguments in the type system
        )

    async def delete(
        self,
        resource_id: str,
        *,
        session_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeleteSessionResource:
        """
        Delete Session Resource

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
        if not resource_id:
            raise ValueError(f"Expected a non-empty value for `resource_id` but received {resource_id!r}")
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
                "/v1/sessions/{session_id}/resources/{resource_id}?beta=true",
                session_id=session_id,
                resource_id=resource_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeleteSessionResource,
        )

    async def add(
        self,
        session_id: str,
        *,
        file_id: str,
        type: Literal["file"],
        mount_path: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsFileResource:
        """
        Add Session Resource

        Args:
          file_id: ID of a previously uploaded file.

          mount_path: Mount path in the container. Defaults to `/mnt/session/uploads/<file_id>`.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not session_id:
            raise ValueError(f"Expected a non-empty value for `session_id` but received {session_id!r}")
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
            path_template("/v1/sessions/{session_id}/resources?beta=true", session_id=session_id),
            body=await async_maybe_transform(
                {
                    "file_id": file_id,
                    "type": type,
                    "mount_path": mount_path,
                },
                resource_add_params.ResourceAddParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsFileResource,
        )


class ResourcesWithRawResponse:
    def __init__(self, resources: Resources) -> None:
        self._resources = resources

        self.retrieve = _legacy_response.to_raw_response_wrapper(
            resources.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            resources.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            resources.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            resources.delete,
        )
        self.add = _legacy_response.to_raw_response_wrapper(
            resources.add,
        )


class AsyncResourcesWithRawResponse:
    def __init__(self, resources: AsyncResources) -> None:
        self._resources = resources

        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            resources.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            resources.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            resources.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            resources.delete,
        )
        self.add = _legacy_response.async_to_raw_response_wrapper(
            resources.add,
        )


class ResourcesWithStreamingResponse:
    def __init__(self, resources: Resources) -> None:
        self._resources = resources

        self.retrieve = to_streamed_response_wrapper(
            resources.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            resources.update,
        )
        self.list = to_streamed_response_wrapper(
            resources.list,
        )
        self.delete = to_streamed_response_wrapper(
            resources.delete,
        )
        self.add = to_streamed_response_wrapper(
            resources.add,
        )


class AsyncResourcesWithStreamingResponse:
    def __init__(self, resources: AsyncResources) -> None:
        self._resources = resources

        self.retrieve = async_to_streamed_response_wrapper(
            resources.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            resources.update,
        )
        self.list = async_to_streamed_response_wrapper(
            resources.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            resources.delete,
        )
        self.add = async_to_streamed_response_wrapper(
            resources.add,
        )
