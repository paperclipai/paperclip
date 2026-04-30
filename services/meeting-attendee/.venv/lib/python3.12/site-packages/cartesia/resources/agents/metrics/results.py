# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from datetime import datetime

import httpx

from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import maybe_transform, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from ....pagination import SyncCursorIDPage, AsyncCursorIDPage
from ...._base_client import AsyncPaginator, make_request_options
from ....types.agents.metrics import result_list_params, result_export_params
from ....types.agents.metrics.result_list_response import ResultListResponse

__all__ = ["ResultsResource", "AsyncResultsResource"]


class ResultsResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> ResultsResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return ResultsResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> ResultsResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return ResultsResourceWithStreamingResponse(self)

    def list(
        self,
        *,
        agent_id: Optional[str] | Omit = omit,
        call_id: Optional[str] | Omit = omit,
        deployment_id: Optional[str] | Omit = omit,
        end_date: Union[str, datetime, None] | Omit = omit,
        ending_before: Optional[str] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        metric_id: Optional[str] | Omit = omit,
        start_date: Union[str, datetime, None] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncCursorIDPage[ResultListResponse]:
        """Paginated list of metric results.

        Filter results using the query parameters,

        Args:
          agent_id: The ID of the agent.

          call_id: The ID of the call.

          deployment_id: The ID of the deployment.

          end_date: Filter metric results created before or at this ISO 8601 date/time (e.g.
              2024-04-30T23:59:59Z).

          ending_before: A cursor to use in pagination. `ending_before` is a metric result ID that
              defines your place in the list. For example, if you make a /metrics/results
              request and receive 100 objects, starting with `metric_result_abc123`, your
              subsequent call can include `ending_before=metric_result_abc123` to fetch the
              previous page of the list.

          limit: The number of metric results to return per page, ranging between 1 and 100.

          metric_id: The ID of the metric.

          start_date: Filter metric results created at or after this ISO 8601 date/time (e.g.
              2024-04-01T00:00:00Z).

          starting_after: A cursor to use in pagination. `starting_after` is a metric result ID that
              defines your place in the list. For example, if you make a /metrics/results
              request and receive 100 objects, ending with `metric_result_abc123`, your
              subsequent call can include `starting_after=metric_result_abc123` to fetch the
              next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/agents/metrics/results",
            page=SyncCursorIDPage[ResultListResponse],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "agent_id": agent_id,
                        "call_id": call_id,
                        "deployment_id": deployment_id,
                        "end_date": end_date,
                        "ending_before": ending_before,
                        "limit": limit,
                        "metric_id": metric_id,
                        "start_date": start_date,
                        "starting_after": starting_after,
                    },
                    result_list_params.ResultListParams,
                ),
            ),
            model=ResultListResponse,
        )

    def export(
        self,
        *,
        agent_id: Optional[str] | Omit = omit,
        call_id: Optional[str] | Omit = omit,
        deployment_id: Optional[str] | Omit = omit,
        end_date: Union[str, datetime, None] | Omit = omit,
        metric_id: Optional[str] | Omit = omit,
        start_date: Union[str, datetime, None] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> str:
        """Export metric results to a CSV file.

        This endpoint streams at most 100k results
        as the CSV file directly to the client. Use the optional filters to narrow down
        the results to export.

        Args:
          agent_id: The ID of the agent.

          call_id: The ID of the call.

          deployment_id: The ID of the deployment.

          end_date: Filter metric results created before or at this ISO 8601 date/time (e.g.
              2024-04-30T23:59:59Z).

          metric_id: The ID of the metric.

          start_date: Filter metric results created at or after this ISO 8601 date/time (e.g.
              2024-04-01T00:00:00Z).

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "text/csv", **(extra_headers or {})}
        return self._get(
            "/agents/metrics/results/export",
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "agent_id": agent_id,
                        "call_id": call_id,
                        "deployment_id": deployment_id,
                        "end_date": end_date,
                        "metric_id": metric_id,
                        "start_date": start_date,
                    },
                    result_export_params.ResultExportParams,
                ),
            ),
            cast_to=str,
        )


class AsyncResultsResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncResultsResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncResultsResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncResultsResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncResultsResourceWithStreamingResponse(self)

    def list(
        self,
        *,
        agent_id: Optional[str] | Omit = omit,
        call_id: Optional[str] | Omit = omit,
        deployment_id: Optional[str] | Omit = omit,
        end_date: Union[str, datetime, None] | Omit = omit,
        ending_before: Optional[str] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        metric_id: Optional[str] | Omit = omit,
        start_date: Union[str, datetime, None] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[ResultListResponse, AsyncCursorIDPage[ResultListResponse]]:
        """Paginated list of metric results.

        Filter results using the query parameters,

        Args:
          agent_id: The ID of the agent.

          call_id: The ID of the call.

          deployment_id: The ID of the deployment.

          end_date: Filter metric results created before or at this ISO 8601 date/time (e.g.
              2024-04-30T23:59:59Z).

          ending_before: A cursor to use in pagination. `ending_before` is a metric result ID that
              defines your place in the list. For example, if you make a /metrics/results
              request and receive 100 objects, starting with `metric_result_abc123`, your
              subsequent call can include `ending_before=metric_result_abc123` to fetch the
              previous page of the list.

          limit: The number of metric results to return per page, ranging between 1 and 100.

          metric_id: The ID of the metric.

          start_date: Filter metric results created at or after this ISO 8601 date/time (e.g.
              2024-04-01T00:00:00Z).

          starting_after: A cursor to use in pagination. `starting_after` is a metric result ID that
              defines your place in the list. For example, if you make a /metrics/results
              request and receive 100 objects, ending with `metric_result_abc123`, your
              subsequent call can include `starting_after=metric_result_abc123` to fetch the
              next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/agents/metrics/results",
            page=AsyncCursorIDPage[ResultListResponse],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "agent_id": agent_id,
                        "call_id": call_id,
                        "deployment_id": deployment_id,
                        "end_date": end_date,
                        "ending_before": ending_before,
                        "limit": limit,
                        "metric_id": metric_id,
                        "start_date": start_date,
                        "starting_after": starting_after,
                    },
                    result_list_params.ResultListParams,
                ),
            ),
            model=ResultListResponse,
        )

    async def export(
        self,
        *,
        agent_id: Optional[str] | Omit = omit,
        call_id: Optional[str] | Omit = omit,
        deployment_id: Optional[str] | Omit = omit,
        end_date: Union[str, datetime, None] | Omit = omit,
        metric_id: Optional[str] | Omit = omit,
        start_date: Union[str, datetime, None] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> str:
        """Export metric results to a CSV file.

        This endpoint streams at most 100k results
        as the CSV file directly to the client. Use the optional filters to narrow down
        the results to export.

        Args:
          agent_id: The ID of the agent.

          call_id: The ID of the call.

          deployment_id: The ID of the deployment.

          end_date: Filter metric results created before or at this ISO 8601 date/time (e.g.
              2024-04-30T23:59:59Z).

          metric_id: The ID of the metric.

          start_date: Filter metric results created at or after this ISO 8601 date/time (e.g.
              2024-04-01T00:00:00Z).

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "text/csv", **(extra_headers or {})}
        return await self._get(
            "/agents/metrics/results/export",
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform(
                    {
                        "agent_id": agent_id,
                        "call_id": call_id,
                        "deployment_id": deployment_id,
                        "end_date": end_date,
                        "metric_id": metric_id,
                        "start_date": start_date,
                    },
                    result_export_params.ResultExportParams,
                ),
            ),
            cast_to=str,
        )


class ResultsResourceWithRawResponse:
    def __init__(self, results: ResultsResource) -> None:
        self._results = results

        self.list = to_raw_response_wrapper(
            results.list,
        )
        self.export = to_raw_response_wrapper(
            results.export,
        )


class AsyncResultsResourceWithRawResponse:
    def __init__(self, results: AsyncResultsResource) -> None:
        self._results = results

        self.list = async_to_raw_response_wrapper(
            results.list,
        )
        self.export = async_to_raw_response_wrapper(
            results.export,
        )


class ResultsResourceWithStreamingResponse:
    def __init__(self, results: ResultsResource) -> None:
        self._results = results

        self.list = to_streamed_response_wrapper(
            results.list,
        )
        self.export = to_streamed_response_wrapper(
            results.export,
        )


class AsyncResultsResourceWithStreamingResponse:
    def __init__(self, results: AsyncResultsResource) -> None:
        self._results = results

        self.list = async_to_streamed_response_wrapper(
            results.list,
        )
        self.export = async_to_streamed_response_wrapper(
            results.export,
        )
