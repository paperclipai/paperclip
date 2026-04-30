# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Iterable, Optional
from datetime import datetime
from itertools import chain
from typing_extensions import Literal

import httpx

from .... import _legacy_response
from .events import (
    Events,
    AsyncEvents,
    EventsWithRawResponse,
    AsyncEventsWithRawResponse,
    EventsWithStreamingResponse,
    AsyncEventsWithStreamingResponse,
)
from ...._types import Body, Omit, Query, Headers, NotGiven, SequenceNotStr, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from .resources import (
    Resources,
    AsyncResources,
    ResourcesWithRawResponse,
    AsyncResourcesWithRawResponse,
    ResourcesWithStreamingResponse,
    AsyncResourcesWithStreamingResponse,
)
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ....types.beta import session_list_params, session_create_params, session_update_params
from ...._base_client import AsyncPaginator, make_request_options
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.beta_managed_agents_session import BetaManagedAgentsSession
from ....types.beta.beta_managed_agents_deleted_session import BetaManagedAgentsDeletedSession

__all__ = ["Sessions", "AsyncSessions"]


class Sessions(SyncAPIResource):
    @cached_property
    def events(self) -> Events:
        return Events(self._client)

    @cached_property
    def resources(self) -> Resources:
        return Resources(self._client)

    @cached_property
    def with_raw_response(self) -> SessionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return SessionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> SessionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return SessionsWithStreamingResponse(self)

    def create(
        self,
        *,
        agent: session_create_params.Agent,
        environment_id: str,
        metadata: Dict[str, str] | Omit = omit,
        resources: Iterable[session_create_params.Resource] | Omit = omit,
        title: Optional[str] | Omit = omit,
        vault_ids: SequenceNotStr[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """Create Session

        Args:
          agent: Agent identifier.

        Accepts the `agent` ID string, which pins the latest version
              for the session, or an `agent` object with both id and version specified.

          environment_id: ID of the `environment` defining the container configuration for this session.

          metadata: Arbitrary key-value metadata attached to the session. Maximum 16 pairs, keys up
              to 64 chars, values up to 512 chars.

          resources: Resources (e.g. repositories, files) to mount into the session's container.

          title: Human-readable session title.

          vault_ids: Vault IDs for stored credentials the agent can use during the session.

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
            "/v1/sessions?beta=true",
            body=maybe_transform(
                {
                    "agent": agent,
                    "environment_id": environment_id,
                    "metadata": metadata,
                    "resources": resources,
                    "title": title,
                    "vault_ids": vault_ids,
                },
                session_create_params.SessionCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )

    def retrieve(
        self,
        session_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """
        Get Session

        Args:
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
        return self._get(
            path_template("/v1/sessions/{session_id}?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )

    def update(
        self,
        session_id: str,
        *,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        title: Optional[str] | Omit = omit,
        vault_ids: SequenceNotStr[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """Update Session

        Args:
          metadata: Metadata patch.

        Set a key to a string to upsert it, or to null to delete it.
              Omit the field to preserve.

          title: Human-readable session title.

          vault_ids: Vault IDs (`vlt_*`) to attach to the session. Not yet supported; requests
              setting this field are rejected. Reserved for future use.

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
            path_template("/v1/sessions/{session_id}?beta=true", session_id=session_id),
            body=maybe_transform(
                {
                    "metadata": metadata,
                    "title": title,
                    "vault_ids": vault_ids,
                },
                session_update_params.SessionUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )

    def list(
        self,
        *,
        agent_id: str | Omit = omit,
        agent_version: int | Omit = omit,
        created_at_gt: Union[str, datetime] | Omit = omit,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lt: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        include_archived: bool | Omit = omit,
        limit: int | Omit = omit,
        order: Literal["asc", "desc"] | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[BetaManagedAgentsSession]:
        """
        List Sessions

        Args:
          agent_id: Filter sessions created with this agent ID.

          agent_version: Filter by agent version. Only applies when agent_id is also set.

          created_at_gt: Return sessions created after this time (exclusive).

          created_at_gte: Return sessions created at or after this time (inclusive).

          created_at_lt: Return sessions created before this time (exclusive).

          created_at_lte: Return sessions created at or before this time (inclusive).

          include_archived: When true, includes archived sessions. Default: false (exclude archived).

          limit: Maximum number of results to return.

          order: Sort direction for results, ordered by created_at. Defaults to desc (newest
              first).

          page: Opaque pagination cursor from a previous response's next_page.

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
            "/v1/sessions?beta=true",
            page=SyncPageCursor[BetaManagedAgentsSession],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "agent_id": agent_id,
                        "agent_version": agent_version,
                        "created_at_gt": created_at_gt,
                        "created_at_gte": created_at_gte,
                        "created_at_lt": created_at_lt,
                        "created_at_lte": created_at_lte,
                        "include_archived": include_archived,
                        "limit": limit,
                        "order": order,
                        "page": page,
                    },
                    session_list_params.SessionListParams,
                ),
            ),
            model=BetaManagedAgentsSession,
        )

    def delete(
        self,
        session_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedSession:
        """
        Delete Session

        Args:
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
        return self._delete(
            path_template("/v1/sessions/{session_id}?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedSession,
        )

    def archive(
        self,
        session_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """
        Archive Session

        Args:
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
            path_template("/v1/sessions/{session_id}/archive?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )


class AsyncSessions(AsyncAPIResource):
    @cached_property
    def events(self) -> AsyncEvents:
        return AsyncEvents(self._client)

    @cached_property
    def resources(self) -> AsyncResources:
        return AsyncResources(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncSessionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncSessionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncSessionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncSessionsWithStreamingResponse(self)

    async def create(
        self,
        *,
        agent: session_create_params.Agent,
        environment_id: str,
        metadata: Dict[str, str] | Omit = omit,
        resources: Iterable[session_create_params.Resource] | Omit = omit,
        title: Optional[str] | Omit = omit,
        vault_ids: SequenceNotStr[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """Create Session

        Args:
          agent: Agent identifier.

        Accepts the `agent` ID string, which pins the latest version
              for the session, or an `agent` object with both id and version specified.

          environment_id: ID of the `environment` defining the container configuration for this session.

          metadata: Arbitrary key-value metadata attached to the session. Maximum 16 pairs, keys up
              to 64 chars, values up to 512 chars.

          resources: Resources (e.g. repositories, files) to mount into the session's container.

          title: Human-readable session title.

          vault_ids: Vault IDs for stored credentials the agent can use during the session.

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
            "/v1/sessions?beta=true",
            body=await async_maybe_transform(
                {
                    "agent": agent,
                    "environment_id": environment_id,
                    "metadata": metadata,
                    "resources": resources,
                    "title": title,
                    "vault_ids": vault_ids,
                },
                session_create_params.SessionCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )

    async def retrieve(
        self,
        session_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """
        Get Session

        Args:
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
        return await self._get(
            path_template("/v1/sessions/{session_id}?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )

    async def update(
        self,
        session_id: str,
        *,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        title: Optional[str] | Omit = omit,
        vault_ids: SequenceNotStr[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """Update Session

        Args:
          metadata: Metadata patch.

        Set a key to a string to upsert it, or to null to delete it.
              Omit the field to preserve.

          title: Human-readable session title.

          vault_ids: Vault IDs (`vlt_*`) to attach to the session. Not yet supported; requests
              setting this field are rejected. Reserved for future use.

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
            path_template("/v1/sessions/{session_id}?beta=true", session_id=session_id),
            body=await async_maybe_transform(
                {
                    "metadata": metadata,
                    "title": title,
                    "vault_ids": vault_ids,
                },
                session_update_params.SessionUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )

    def list(
        self,
        *,
        agent_id: str | Omit = omit,
        agent_version: int | Omit = omit,
        created_at_gt: Union[str, datetime] | Omit = omit,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lt: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        include_archived: bool | Omit = omit,
        limit: int | Omit = omit,
        order: Literal["asc", "desc"] | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[BetaManagedAgentsSession, AsyncPageCursor[BetaManagedAgentsSession]]:
        """
        List Sessions

        Args:
          agent_id: Filter sessions created with this agent ID.

          agent_version: Filter by agent version. Only applies when agent_id is also set.

          created_at_gt: Return sessions created after this time (exclusive).

          created_at_gte: Return sessions created at or after this time (inclusive).

          created_at_lt: Return sessions created before this time (exclusive).

          created_at_lte: Return sessions created at or before this time (inclusive).

          include_archived: When true, includes archived sessions. Default: false (exclude archived).

          limit: Maximum number of results to return.

          order: Sort direction for results, ordered by created_at. Defaults to desc (newest
              first).

          page: Opaque pagination cursor from a previous response's next_page.

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
            "/v1/sessions?beta=true",
            page=AsyncPageCursor[BetaManagedAgentsSession],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "agent_id": agent_id,
                        "agent_version": agent_version,
                        "created_at_gt": created_at_gt,
                        "created_at_gte": created_at_gte,
                        "created_at_lt": created_at_lt,
                        "created_at_lte": created_at_lte,
                        "include_archived": include_archived,
                        "limit": limit,
                        "order": order,
                        "page": page,
                    },
                    session_list_params.SessionListParams,
                ),
            ),
            model=BetaManagedAgentsSession,
        )

    async def delete(
        self,
        session_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedSession:
        """
        Delete Session

        Args:
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
        return await self._delete(
            path_template("/v1/sessions/{session_id}?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedSession,
        )

    async def archive(
        self,
        session_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSession:
        """
        Archive Session

        Args:
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
            path_template("/v1/sessions/{session_id}/archive?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSession,
        )


class SessionsWithRawResponse:
    def __init__(self, sessions: Sessions) -> None:
        self._sessions = sessions

        self.create = _legacy_response.to_raw_response_wrapper(
            sessions.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            sessions.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            sessions.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            sessions.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            sessions.delete,
        )
        self.archive = _legacy_response.to_raw_response_wrapper(
            sessions.archive,
        )

    @cached_property
    def events(self) -> EventsWithRawResponse:
        return EventsWithRawResponse(self._sessions.events)

    @cached_property
    def resources(self) -> ResourcesWithRawResponse:
        return ResourcesWithRawResponse(self._sessions.resources)


class AsyncSessionsWithRawResponse:
    def __init__(self, sessions: AsyncSessions) -> None:
        self._sessions = sessions

        self.create = _legacy_response.async_to_raw_response_wrapper(
            sessions.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            sessions.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            sessions.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            sessions.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            sessions.delete,
        )
        self.archive = _legacy_response.async_to_raw_response_wrapper(
            sessions.archive,
        )

    @cached_property
    def events(self) -> AsyncEventsWithRawResponse:
        return AsyncEventsWithRawResponse(self._sessions.events)

    @cached_property
    def resources(self) -> AsyncResourcesWithRawResponse:
        return AsyncResourcesWithRawResponse(self._sessions.resources)


class SessionsWithStreamingResponse:
    def __init__(self, sessions: Sessions) -> None:
        self._sessions = sessions

        self.create = to_streamed_response_wrapper(
            sessions.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            sessions.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            sessions.update,
        )
        self.list = to_streamed_response_wrapper(
            sessions.list,
        )
        self.delete = to_streamed_response_wrapper(
            sessions.delete,
        )
        self.archive = to_streamed_response_wrapper(
            sessions.archive,
        )

    @cached_property
    def events(self) -> EventsWithStreamingResponse:
        return EventsWithStreamingResponse(self._sessions.events)

    @cached_property
    def resources(self) -> ResourcesWithStreamingResponse:
        return ResourcesWithStreamingResponse(self._sessions.resources)


class AsyncSessionsWithStreamingResponse:
    def __init__(self, sessions: AsyncSessions) -> None:
        self._sessions = sessions

        self.create = async_to_streamed_response_wrapper(
            sessions.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            sessions.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            sessions.update,
        )
        self.list = async_to_streamed_response_wrapper(
            sessions.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            sessions.delete,
        )
        self.archive = async_to_streamed_response_wrapper(
            sessions.archive,
        )

    @cached_property
    def events(self) -> AsyncEventsWithStreamingResponse:
        return AsyncEventsWithStreamingResponse(self._sessions.events)

    @cached_property
    def resources(self) -> AsyncResourcesWithStreamingResponse:
        return AsyncResourcesWithStreamingResponse(self._sessions.resources)
