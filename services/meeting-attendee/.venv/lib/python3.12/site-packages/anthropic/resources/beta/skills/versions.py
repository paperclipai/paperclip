# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Mapping, Optional, cast
from itertools import chain

import httpx

from .... import _legacy_response
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
from ...._base_client import AsyncPaginator, make_request_options
from ....types.beta.skills import version_list_params, version_create_params
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.skills.version_list_response import VersionListResponse
from ....types.beta.skills.version_create_response import VersionCreateResponse
from ....types.beta.skills.version_delete_response import VersionDeleteResponse
from ....types.beta.skills.version_retrieve_response import VersionRetrieveResponse

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

    def create(
        self,
        skill_id: str,
        *,
        files: Optional[SequenceNotStr[FileTypes]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VersionCreateResponse:
        """
        Create Skill Version

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          files: Files to upload for the skill.

              All files must be in the same top-level directory and must include a SKILL.md
              file at the root of that directory.

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
        body = deepcopy_with_paths({"files": files}, [["files", "<array>"]])
        extracted_files = extract_files(cast(Mapping[str, object], body), paths=[["files", "<array>"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers["Content-Type"] = "multipart/form-data"
        return self._post(
            path_template("/v1/skills/{skill_id}/versions?beta=true", skill_id=skill_id),
            body=maybe_transform(body, version_create_params.VersionCreateParams),
            files=extracted_files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VersionCreateResponse,
        )

    def retrieve(
        self,
        version: str,
        *,
        skill_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VersionRetrieveResponse:
        """
        Get Skill Version

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          version: Version identifier for the skill.

              Each version is identified by a Unix epoch timestamp (e.g., "1759178010641129").

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        if not version:
            raise ValueError(f"Expected a non-empty value for `version` but received {version!r}")
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
            path_template("/v1/skills/{skill_id}/versions/{version}?beta=true", skill_id=skill_id, version=version),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VersionRetrieveResponse,
        )

    def list(
        self,
        skill_id: str,
        *,
        limit: Optional[int] | Omit = omit,
        page: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[VersionListResponse]:
        """
        List Skill Versions

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          limit: Number of items to return per page.

              Defaults to `20`. Ranges from `1` to `1000`.

          page: Optionally set to the `next_page` token from the previous response.

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
        return self._get_api_list(
            path_template("/v1/skills/{skill_id}/versions?beta=true", skill_id=skill_id),
            page=SyncPageCursor[VersionListResponse],
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
            model=VersionListResponse,
        )

    def delete(
        self,
        version: str,
        *,
        skill_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VersionDeleteResponse:
        """
        Delete Skill Version

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          version: Version identifier for the skill.

              Each version is identified by a Unix epoch timestamp (e.g., "1759178010641129").

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        if not version:
            raise ValueError(f"Expected a non-empty value for `version` but received {version!r}")
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
            path_template("/v1/skills/{skill_id}/versions/{version}?beta=true", skill_id=skill_id, version=version),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VersionDeleteResponse,
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

    async def create(
        self,
        skill_id: str,
        *,
        files: Optional[SequenceNotStr[FileTypes]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VersionCreateResponse:
        """
        Create Skill Version

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          files: Files to upload for the skill.

              All files must be in the same top-level directory and must include a SKILL.md
              file at the root of that directory.

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
        body = deepcopy_with_paths({"files": files}, [["files", "<array>"]])
        extracted_files = extract_files(cast(Mapping[str, object], body), paths=[["files", "<array>"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers["Content-Type"] = "multipart/form-data"
        return await self._post(
            path_template("/v1/skills/{skill_id}/versions?beta=true", skill_id=skill_id),
            body=await async_maybe_transform(body, version_create_params.VersionCreateParams),
            files=extracted_files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VersionCreateResponse,
        )

    async def retrieve(
        self,
        version: str,
        *,
        skill_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VersionRetrieveResponse:
        """
        Get Skill Version

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          version: Version identifier for the skill.

              Each version is identified by a Unix epoch timestamp (e.g., "1759178010641129").

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        if not version:
            raise ValueError(f"Expected a non-empty value for `version` but received {version!r}")
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
            path_template("/v1/skills/{skill_id}/versions/{version}?beta=true", skill_id=skill_id, version=version),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VersionRetrieveResponse,
        )

    def list(
        self,
        skill_id: str,
        *,
        limit: Optional[int] | Omit = omit,
        page: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[VersionListResponse, AsyncPageCursor[VersionListResponse]]:
        """
        List Skill Versions

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          limit: Number of items to return per page.

              Defaults to `20`. Ranges from `1` to `1000`.

          page: Optionally set to the `next_page` token from the previous response.

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
        return self._get_api_list(
            path_template("/v1/skills/{skill_id}/versions?beta=true", skill_id=skill_id),
            page=AsyncPageCursor[VersionListResponse],
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
            model=VersionListResponse,
        )

    async def delete(
        self,
        version: str,
        *,
        skill_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VersionDeleteResponse:
        """
        Delete Skill Version

        Args:
          skill_id: Unique identifier for the skill.

              The format and length of IDs may change over time.

          version: Version identifier for the skill.

              Each version is identified by a Unix epoch timestamp (e.g., "1759178010641129").

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not skill_id:
            raise ValueError(f"Expected a non-empty value for `skill_id` but received {skill_id!r}")
        if not version:
            raise ValueError(f"Expected a non-empty value for `version` but received {version!r}")
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
            path_template("/v1/skills/{skill_id}/versions/{version}?beta=true", skill_id=skill_id, version=version),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VersionDeleteResponse,
        )


class VersionsWithRawResponse:
    def __init__(self, versions: Versions) -> None:
        self._versions = versions

        self.create = _legacy_response.to_raw_response_wrapper(
            versions.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            versions.retrieve,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            versions.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            versions.delete,
        )


class AsyncVersionsWithRawResponse:
    def __init__(self, versions: AsyncVersions) -> None:
        self._versions = versions

        self.create = _legacy_response.async_to_raw_response_wrapper(
            versions.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            versions.retrieve,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            versions.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            versions.delete,
        )


class VersionsWithStreamingResponse:
    def __init__(self, versions: Versions) -> None:
        self._versions = versions

        self.create = to_streamed_response_wrapper(
            versions.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            versions.retrieve,
        )
        self.list = to_streamed_response_wrapper(
            versions.list,
        )
        self.delete = to_streamed_response_wrapper(
            versions.delete,
        )


class AsyncVersionsWithStreamingResponse:
    def __init__(self, versions: AsyncVersions) -> None:
        self._versions = versions

        self.create = async_to_streamed_response_wrapper(
            versions.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            versions.retrieve,
        )
        self.list = async_to_streamed_response_wrapper(
            versions.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            versions.delete,
        )
