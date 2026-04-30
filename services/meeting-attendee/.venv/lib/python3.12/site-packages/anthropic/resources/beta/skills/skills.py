# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Mapping, Optional, cast
from itertools import chain

import httpx

from .... import _legacy_response
from .versions import (
    Versions,
    AsyncVersions,
    VersionsWithRawResponse,
    AsyncVersionsWithRawResponse,
    VersionsWithStreamingResponse,
    AsyncVersionsWithStreamingResponse,
)
from ...._files import deepcopy_with_paths
from ...._types import (
    Body,
    Omit,
    Query,
    Headers,
    NotGiven,
    FileTypes,
    SequenceNotStr,
    omit,
    not_given,
)
from ...._utils import is_given, extract_files, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ....types.beta import skill_list_params, skill_create_params
from ...._base_client import AsyncPaginator, make_request_options
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.skill_list_response import SkillListResponse
from ....types.beta.skill_create_response import SkillCreateResponse
from ....types.beta.skill_delete_response import SkillDeleteResponse
from ....types.beta.skill_retrieve_response import SkillRetrieveResponse

__all__ = ["Skills", "AsyncSkills"]


class Skills(SyncAPIResource):
    @cached_property
    def versions(self) -> Versions:
        return Versions(self._client)

    @cached_property
    def with_raw_response(self) -> SkillsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return SkillsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> SkillsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return SkillsWithStreamingResponse(self)

    def create(
        self,
        *,
        display_title: Optional[str] | Omit = omit,
        files: Optional[SequenceNotStr[FileTypes]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SkillCreateResponse:
        """
        Create Skill

        Args:
          display_title: Display title for the skill.

              This is a human-readable label that is not included in the prompt sent to the
              model.

          files: Files to upload for the skill.

              All files must be in the same top-level directory and must include a SKILL.md
              file at the root of that directory.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        body = deepcopy_with_paths(
            {
                "display_title": display_title,
                "files": files,
            },
            [["files", "<array>"]],
        )
        extracted_files = extract_files(cast(Mapping[str, object], body), paths=[["files", "<array>"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers["Content-Type"] = "multipart/form-data"
        return self._post(
            "/v1/skills?beta=true",
            body=maybe_transform(body, skill_create_params.SkillCreateParams),
            files=extracted_files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=SkillCreateResponse,
        )

    def retrieve(
        self,
        skill_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SkillRetrieveResponse:
        """
        Get Skill

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        return self._get(
            path_template("/v1/skills/{skill_id}?beta=true", skill_id=skill_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=SkillRetrieveResponse,
        )

    def list(
        self,
        *,
        limit: int | Omit = omit,
        page: Optional[str] | Omit = omit,
        source: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[SkillListResponse]:
        """
        List Skills

        Args:
          limit: Number of results to return per page.

              Maximum value is 100. Defaults to 20.

          page: Pagination token for fetching a specific page of results.

              Pass the value from a previous response's `next_page` field to get the next page
              of results.

          source: Filter skills by source.

              If provided, only skills from the specified source will be returned:

              - `"custom"`: only return user-created skills
              - `"anthropic"`: only return Anthropic-created skills

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        return self._get_api_list(
            "/v1/skills?beta=true",
            page=SyncPageCursor[SkillListResponse],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "page": page,
                        "source": source,
                    },
                    skill_list_params.SkillListParams,
                ),
            ),
            model=SkillListResponse,
        )

    def delete(
        self,
        skill_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SkillDeleteResponse:
        """
        Delete Skill

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        return self._delete(
            path_template("/v1/skills/{skill_id}?beta=true", skill_id=skill_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=SkillDeleteResponse,
        )


class AsyncSkills(AsyncAPIResource):
    @cached_property
    def versions(self) -> AsyncVersions:
        return AsyncVersions(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncSkillsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncSkillsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncSkillsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncSkillsWithStreamingResponse(self)

    async def create(
        self,
        *,
        display_title: Optional[str] | Omit = omit,
        files: Optional[SequenceNotStr[FileTypes]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SkillCreateResponse:
        """
        Create Skill

        Args:
          display_title: Display title for the skill.

              This is a human-readable label that is not included in the prompt sent to the
              model.

          files: Files to upload for the skill.

              All files must be in the same top-level directory and must include a SKILL.md
              file at the root of that directory.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        body = deepcopy_with_paths(
            {
                "display_title": display_title,
                "files": files,
            },
            [["files", "<array>"]],
        )
        extracted_files = extract_files(cast(Mapping[str, object], body), paths=[["files", "<array>"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers["Content-Type"] = "multipart/form-data"
        return await self._post(
            "/v1/skills?beta=true",
            body=await async_maybe_transform(body, skill_create_params.SkillCreateParams),
            files=extracted_files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=SkillCreateResponse,
        )

    async def retrieve(
        self,
        skill_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SkillRetrieveResponse:
        """
        Get Skill

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        return await self._get(
            path_template("/v1/skills/{skill_id}?beta=true", skill_id=skill_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=SkillRetrieveResponse,
        )

    def list(
        self,
        *,
        limit: int | Omit = omit,
        page: Optional[str] | Omit = omit,
        source: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[SkillListResponse, AsyncPageCursor[SkillListResponse]]:
        """
        List Skills

        Args:
          limit: Number of results to return per page.

              Maximum value is 100. Defaults to 20.

          page: Pagination token for fetching a specific page of results.

              Pass the value from a previous response's `next_page` field to get the next page
              of results.

          source: Filter skills by source.

              If provided, only skills from the specified source will be returned:

              - `"custom"`: only return user-created skills
              - `"anthropic"`: only return Anthropic-created skills

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        return self._get_api_list(
            "/v1/skills?beta=true",
            page=AsyncPageCursor[SkillListResponse],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "limit": limit,
                        "page": page,
                        "source": source,
                    },
                    skill_list_params.SkillListParams,
                ),
            ),
            model=SkillListResponse,
        )

    async def delete(
        self,
        skill_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SkillDeleteResponse:
        """
        Delete Skill

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["skills-2025-10-02"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "skills-2025-10-02", **(extra_headers or {})}
        return await self._delete(
            path_template("/v1/skills/{skill_id}?beta=true", skill_id=skill_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=SkillDeleteResponse,
        )


class SkillsWithRawResponse:
    def __init__(self, skills: Skills) -> None:
        self._skills = skills

        self.create = _legacy_response.to_raw_response_wrapper(
            skills.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            skills.retrieve,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            skills.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            skills.delete,
        )

    @cached_property
    def versions(self) -> VersionsWithRawResponse:
        return VersionsWithRawResponse(self._skills.versions)


class AsyncSkillsWithRawResponse:
    def __init__(self, skills: AsyncSkills) -> None:
        self._skills = skills

        self.create = _legacy_response.async_to_raw_response_wrapper(
            skills.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            skills.retrieve,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            skills.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            skills.delete,
        )

    @cached_property
    def versions(self) -> AsyncVersionsWithRawResponse:
        return AsyncVersionsWithRawResponse(self._skills.versions)


class SkillsWithStreamingResponse:
    def __init__(self, skills: Skills) -> None:
        self._skills = skills

        self.create = to_streamed_response_wrapper(
            skills.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            skills.retrieve,
        )
        self.list = to_streamed_response_wrapper(
            skills.list,
        )
        self.delete = to_streamed_response_wrapper(
            skills.delete,
        )

    @cached_property
    def versions(self) -> VersionsWithStreamingResponse:
        return VersionsWithStreamingResponse(self._skills.versions)


class AsyncSkillsWithStreamingResponse:
    def __init__(self, skills: AsyncSkills) -> None:
        self._skills = skills

        self.create = async_to_streamed_response_wrapper(
            skills.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            skills.retrieve,
        )
        self.list = async_to_streamed_response_wrapper(
            skills.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            skills.delete,
        )

    @cached_property
    def versions(self) -> AsyncVersionsWithStreamingResponse:
        return AsyncVersionsWithStreamingResponse(self._skills.versions)
