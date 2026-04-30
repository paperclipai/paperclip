# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional

import httpx

from .results import (
    ResultsResource,
    AsyncResultsResource,
    ResultsResourceWithRawResponse,
    AsyncResultsResourceWithRawResponse,
    ResultsResourceWithStreamingResponse,
    AsyncResultsResourceWithStreamingResponse,
)
from ...._types import Body, Omit, Query, Headers, NoneType, NotGiven, omit, not_given
from ...._utils import maybe_transform, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from ...._base_client import make_request_options
from ....types.agents import metric_list_params, metric_create_params
from ....types.agents.metric import Metric
from ....types.agents.metric_list_response import MetricListResponse

__all__ = ["MetricsResource", "AsyncMetricsResource"]


class MetricsResource(SyncAPIResource):
    @cached_property
    def results(self) -> ResultsResource:
        return ResultsResource(self._client)

    @cached_property
    def with_raw_response(self) -> MetricsResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return MetricsResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> MetricsResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return MetricsResourceWithStreamingResponse(self)

    def create(
        self,
        *,
        name: str,
        prompt: str,
        display_name: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Metric:
        """Create a new metric.

        Args:
          name: The name of the metric.

        This must be a unique name that only allows lower case
              letters, numbers, and the characters \\__, -, and .

          prompt: The prompt associated with the metric, detailing the task and evaluation
              criteria.

          display_name: The display name of the metric.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._post(
            "/agents/metrics",
            body=maybe_transform(
                {
                    "name": name,
                    "prompt": prompt,
                    "display_name": display_name,
                },
                metric_create_params.MetricCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Metric,
        )

    def retrieve(
        self,
        metric_id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Metric:
        """
        Get a metric by its ID.

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not metric_id:
            raise ValueError(f"Expected a non-empty value for `metric_id` but received {metric_id!r}")
        return self._get(
            f"/agents/metrics/{metric_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Metric,
        )

    def list(
        self,
        *,
        limit: Optional[int] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MetricListResponse:
        """
        List of all LLM-as-a-Judge metrics owned by your account.

        Args:
          limit: (Pagination option) The number of metrics to return per page, ranging between 1
              and 100. The default page limit is 10.

          starting_after: (Pagination option) The ID of the last Metric in the current response as a
              cursor for the next page of results.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get(
            "/agents/metrics",
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "starting_after": starting_after,
                    },
                    metric_list_params.MetricListParams,
                ),
            ),
            cast_to=MetricListResponse,
        )

    def add_to_agent(
        self,
        metric_id: str,
        *,
        agent_id: str,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """Add a metric to an agent.

        Once the metric is added, it will be run on all calls
        made to the agent automatically from that point onwards.

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        if not metric_id:
            raise ValueError(f"Expected a non-empty value for `metric_id` but received {metric_id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return self._post(
            f"/agents/{agent_id}/metrics/{metric_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )

    def remove_from_agent(
        self,
        metric_id: str,
        *,
        agent_id: str,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """Remove a metric from an agent.

        Once the metric is removed, it will no longer be
        run on all calls made to the agent automatically from that point onwards.
        Existing metric results will remain.

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        if not metric_id:
            raise ValueError(f"Expected a non-empty value for `metric_id` but received {metric_id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return self._delete(
            f"/agents/{agent_id}/metrics/{metric_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )


class AsyncMetricsResource(AsyncAPIResource):
    @cached_property
    def results(self) -> AsyncResultsResource:
        return AsyncResultsResource(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncMetricsResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncMetricsResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncMetricsResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncMetricsResourceWithStreamingResponse(self)

    async def create(
        self,
        *,
        name: str,
        prompt: str,
        display_name: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Metric:
        """Create a new metric.

        Args:
          name: The name of the metric.

        This must be a unique name that only allows lower case
              letters, numbers, and the characters \\__, -, and .

          prompt: The prompt associated with the metric, detailing the task and evaluation
              criteria.

          display_name: The display name of the metric.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return await self._post(
            "/agents/metrics",
            body=await async_maybe_transform(
                {
                    "name": name,
                    "prompt": prompt,
                    "display_name": display_name,
                },
                metric_create_params.MetricCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Metric,
        )

    async def retrieve(
        self,
        metric_id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Metric:
        """
        Get a metric by its ID.

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not metric_id:
            raise ValueError(f"Expected a non-empty value for `metric_id` but received {metric_id!r}")
        return await self._get(
            f"/agents/metrics/{metric_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Metric,
        )

    async def list(
        self,
        *,
        limit: Optional[int] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MetricListResponse:
        """
        List of all LLM-as-a-Judge metrics owned by your account.

        Args:
          limit: (Pagination option) The number of metrics to return per page, ranging between 1
              and 100. The default page limit is 10.

          starting_after: (Pagination option) The ID of the last Metric in the current response as a
              cursor for the next page of results.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return await self._get(
            "/agents/metrics",
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform(
                    {
                        "limit": limit,
                        "starting_after": starting_after,
                    },
                    metric_list_params.MetricListParams,
                ),
            ),
            cast_to=MetricListResponse,
        )

    async def add_to_agent(
        self,
        metric_id: str,
        *,
        agent_id: str,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """Add a metric to an agent.

        Once the metric is added, it will be run on all calls
        made to the agent automatically from that point onwards.

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        if not metric_id:
            raise ValueError(f"Expected a non-empty value for `metric_id` but received {metric_id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return await self._post(
            f"/agents/{agent_id}/metrics/{metric_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )

    async def remove_from_agent(
        self,
        metric_id: str,
        *,
        agent_id: str,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """Remove a metric from an agent.

        Once the metric is removed, it will no longer be
        run on all calls made to the agent automatically from that point onwards.
        Existing metric results will remain.

        Args:
          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        if not metric_id:
            raise ValueError(f"Expected a non-empty value for `metric_id` but received {metric_id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return await self._delete(
            f"/agents/{agent_id}/metrics/{metric_id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )


class MetricsResourceWithRawResponse:
    def __init__(self, metrics: MetricsResource) -> None:
        self._metrics = metrics

        self.create = to_raw_response_wrapper(
            metrics.create,
        )
        self.retrieve = to_raw_response_wrapper(
            metrics.retrieve,
        )
        self.list = to_raw_response_wrapper(
            metrics.list,
        )
        self.add_to_agent = to_raw_response_wrapper(
            metrics.add_to_agent,
        )
        self.remove_from_agent = to_raw_response_wrapper(
            metrics.remove_from_agent,
        )

    @cached_property
    def results(self) -> ResultsResourceWithRawResponse:
        return ResultsResourceWithRawResponse(self._metrics.results)


class AsyncMetricsResourceWithRawResponse:
    def __init__(self, metrics: AsyncMetricsResource) -> None:
        self._metrics = metrics

        self.create = async_to_raw_response_wrapper(
            metrics.create,
        )
        self.retrieve = async_to_raw_response_wrapper(
            metrics.retrieve,
        )
        self.list = async_to_raw_response_wrapper(
            metrics.list,
        )
        self.add_to_agent = async_to_raw_response_wrapper(
            metrics.add_to_agent,
        )
        self.remove_from_agent = async_to_raw_response_wrapper(
            metrics.remove_from_agent,
        )

    @cached_property
    def results(self) -> AsyncResultsResourceWithRawResponse:
        return AsyncResultsResourceWithRawResponse(self._metrics.results)


class MetricsResourceWithStreamingResponse:
    def __init__(self, metrics: MetricsResource) -> None:
        self._metrics = metrics

        self.create = to_streamed_response_wrapper(
            metrics.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            metrics.retrieve,
        )
        self.list = to_streamed_response_wrapper(
            metrics.list,
        )
        self.add_to_agent = to_streamed_response_wrapper(
            metrics.add_to_agent,
        )
        self.remove_from_agent = to_streamed_response_wrapper(
            metrics.remove_from_agent,
        )

    @cached_property
    def results(self) -> ResultsResourceWithStreamingResponse:
        return ResultsResourceWithStreamingResponse(self._metrics.results)


class AsyncMetricsResourceWithStreamingResponse:
    def __init__(self, metrics: AsyncMetricsResource) -> None:
        self._metrics = metrics

        self.create = async_to_streamed_response_wrapper(
            metrics.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            metrics.retrieve,
        )
        self.list = async_to_streamed_response_wrapper(
            metrics.list,
        )
        self.add_to_agent = async_to_streamed_response_wrapper(
            metrics.add_to_agent,
        )
        self.remove_from_agent = async_to_streamed_response_wrapper(
            metrics.remove_from_agent,
        )

    @cached_property
    def results(self) -> AsyncResultsResourceWithStreamingResponse:
        return AsyncResultsResourceWithStreamingResponse(self._metrics.results)
