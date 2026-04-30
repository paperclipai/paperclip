# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Any, List, Iterable, cast
from itertools import chain
from typing_extensions import Literal

import httpx

from .... import _legacy_response
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ...._streaming import Stream, AsyncStream
from ....pagination import SyncPageCursor, AsyncPageCursor
from ...._base_client import AsyncPaginator, make_request_options
from ....types.beta.sessions import event_list_params, event_send_params
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.sessions.beta_managed_agents_event_params import BetaManagedAgentsEventParams
from ....types.beta.sessions.beta_managed_agents_session_event import BetaManagedAgentsSessionEvent
from ....types.beta.sessions.beta_managed_agents_send_session_events import BetaManagedAgentsSendSessionEvents
from ....types.beta.sessions.beta_managed_agents_stream_session_events import BetaManagedAgentsStreamSessionEvents

__all__ = ["Events", "AsyncEvents"]


class Events(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> EventsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return EventsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> EventsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return EventsWithStreamingResponse(self)

    def list(
        self,
        session_id: str,
        *,
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
    ) -> SyncPageCursor[BetaManagedAgentsSessionEvent]:
        """
        List Events

        Args:
          limit: Query parameter for limit

          order: Sort direction for results, ordered by created_at. Defaults to asc
              (chronological).

          page: Opaque pagination cursor from a previous response's next_page.

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
            path_template("/v1/sessions/{session_id}/events?beta=true", session_id=session_id),
            page=SyncPageCursor[BetaManagedAgentsSessionEvent],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "order": order,
                        "page": page,
                    },
                    event_list_params.EventListParams,
                ),
            ),
            model=cast(
                Any, BetaManagedAgentsSessionEvent
            ),  # Union types cannot be passed in as arguments in the type system
        )

    def send(
        self,
        session_id: str,
        *,
        events: Iterable[BetaManagedAgentsEventParams],
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSendSessionEvents:
        """
        Send Events

        Args:
          events: Events to send to the `session`.

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
            path_template("/v1/sessions/{session_id}/events?beta=true", session_id=session_id),
            body=maybe_transform({"events": events}, event_send_params.EventSendParams),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSendSessionEvents,
        )

    def stream(
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
    ) -> Stream[BetaManagedAgentsStreamSessionEvents]:
        """
        Stream Events

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
            path_template("/v1/sessions/{session_id}/events/stream?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=cast(
                Any, BetaManagedAgentsStreamSessionEvents
            ),  # Union types cannot be passed in as arguments in the type system
            stream=True,
            stream_cls=Stream[BetaManagedAgentsStreamSessionEvents],
        )


class AsyncEvents(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncEventsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncEventsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncEventsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncEventsWithStreamingResponse(self)

    def list(
        self,
        session_id: str,
        *,
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
    ) -> AsyncPaginator[BetaManagedAgentsSessionEvent, AsyncPageCursor[BetaManagedAgentsSessionEvent]]:
        """
        List Events

        Args:
          limit: Query parameter for limit

          order: Sort direction for results, ordered by created_at. Defaults to asc
              (chronological).

          page: Opaque pagination cursor from a previous response's next_page.

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
            path_template("/v1/sessions/{session_id}/events?beta=true", session_id=session_id),
            page=AsyncPageCursor[BetaManagedAgentsSessionEvent],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "order": order,
                        "page": page,
                    },
                    event_list_params.EventListParams,
                ),
            ),
            model=cast(
                Any, BetaManagedAgentsSessionEvent
            ),  # Union types cannot be passed in as arguments in the type system
        )

    async def send(
        self,
        session_id: str,
        *,
        events: Iterable[BetaManagedAgentsEventParams],
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsSendSessionEvents:
        """
        Send Events

        Args:
          events: Events to send to the `session`.

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
            path_template("/v1/sessions/{session_id}/events?beta=true", session_id=session_id),
            body=await async_maybe_transform({"events": events}, event_send_params.EventSendParams),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsSendSessionEvents,
        )

    async def stream(
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
    ) -> AsyncStream[BetaManagedAgentsStreamSessionEvents]:
        """
        Stream Events

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
            path_template("/v1/sessions/{session_id}/events/stream?beta=true", session_id=session_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=cast(
                Any, BetaManagedAgentsStreamSessionEvents
            ),  # Union types cannot be passed in as arguments in the type system
            stream=True,
            stream_cls=AsyncStream[BetaManagedAgentsStreamSessionEvents],
        )


class EventsWithRawResponse:
    def __init__(self, events: Events) -> None:
        self._events = events

        self.list = _legacy_response.to_raw_response_wrapper(
            events.list,
        )
        self.send = _legacy_response.to_raw_response_wrapper(
            events.send,
        )
        self.stream = _legacy_response.to_raw_response_wrapper(
            events.stream,
        )


class AsyncEventsWithRawResponse:
    def __init__(self, events: AsyncEvents) -> None:
        self._events = events

        self.list = _legacy_response.async_to_raw_response_wrapper(
            events.list,
        )
        self.send = _legacy_response.async_to_raw_response_wrapper(
            events.send,
        )
        self.stream = _legacy_response.async_to_raw_response_wrapper(
            events.stream,
        )


class EventsWithStreamingResponse:
    def __init__(self, events: Events) -> None:
        self._events = events

        self.list = to_streamed_response_wrapper(
            events.list,
        )
        self.send = to_streamed_response_wrapper(
            events.send,
        )
        self.stream = to_streamed_response_wrapper(
            events.stream,
        )


class AsyncEventsWithStreamingResponse:
    def __init__(self, events: AsyncEvents) -> None:
        self._events = events

        self.list = async_to_streamed_response_wrapper(
            events.list,
        )
        self.send = async_to_streamed_response_wrapper(
            events.send,
        )
        self.stream = async_to_streamed_response_wrapper(
            events.stream,
        )
