# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from itertools import chain
from typing_extensions import Literal

import httpx

from ... import _legacy_response
from ..._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ..._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ..._compat import cached_property
from ..._resource import SyncAPIResource, AsyncAPIResource
from ..._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ...pagination import SyncPageCursor, AsyncPageCursor
from ...types.beta import user_profile_list_params, user_profile_create_params, user_profile_update_params
from ..._base_client import AsyncPaginator, make_request_options
from ...types.anthropic_beta_param import AnthropicBetaParam
from ...types.beta.beta_user_profile import BetaUserProfile
from ...types.beta.beta_user_profile_enrollment_url import BetaUserProfileEnrollmentURL

__all__ = ["UserProfiles", "AsyncUserProfiles"]


class UserProfiles(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> UserProfilesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return UserProfilesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> UserProfilesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return UserProfilesWithStreamingResponse(self)

    def create(
        self,
        *,
        external_id: Optional[str] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfile:
        """
        Create User Profile

        Args:
          external_id: Platform's own identifier for this user. Not enforced unique. Maximum 255
              characters.

          metadata: Free-form key-value data to attach to this user profile. Maximum 16 keys, with
              keys up to 64 characters and values up to 512 characters. Values must be
              non-empty strings.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return self._post(
            "/v1/user_profiles?beta=true",
            body=maybe_transform(
                {
                    "external_id": external_id,
                    "metadata": metadata,
                },
                user_profile_create_params.UserProfileCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfile,
        )

    def retrieve(
        self,
        user_profile_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfile:
        """
        Get User Profile

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not user_profile_id:
            raise ValueError(f"Expected a non-empty value for `user_profile_id` but received {user_profile_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return self._get(
            path_template("/v1/user_profiles/{user_profile_id}?beta=true", user_profile_id=user_profile_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfile,
        )

    def update(
        self,
        user_profile_id: str,
        *,
        external_id: Optional[str] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfile:
        """
        Update User Profile

        Args:
          external_id: If present, replaces the stored external_id. Omit to leave unchanged. Maximum
              255 characters.

          metadata: Key-value pairs to merge into the stored metadata. Keys provided overwrite
              existing values. To remove a key, set its value to an empty string. Keys not
              provided are left unchanged. Maximum 16 keys, with keys up to 64 characters and
              values up to 512 characters.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not user_profile_id:
            raise ValueError(f"Expected a non-empty value for `user_profile_id` but received {user_profile_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return self._post(
            path_template("/v1/user_profiles/{user_profile_id}?beta=true", user_profile_id=user_profile_id),
            body=maybe_transform(
                {
                    "external_id": external_id,
                    "metadata": metadata,
                },
                user_profile_update_params.UserProfileUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfile,
        )

    def list(
        self,
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
    ) -> SyncPageCursor[BetaUserProfile]:
        """
        List User Profiles

        Args:
          limit: Query parameter for limit

          order: Query parameter for order

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
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return self._get_api_list(
            "/v1/user_profiles?beta=true",
            page=SyncPageCursor[BetaUserProfile],
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
                    user_profile_list_params.UserProfileListParams,
                ),
            ),
            model=BetaUserProfile,
        )

    def create_enrollment_url(
        self,
        user_profile_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfileEnrollmentURL:
        """
        Create Enrollment URL

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not user_profile_id:
            raise ValueError(f"Expected a non-empty value for `user_profile_id` but received {user_profile_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return self._post(
            path_template(
                "/v1/user_profiles/{user_profile_id}/enrollment_url?beta=true", user_profile_id=user_profile_id
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfileEnrollmentURL,
        )


class AsyncUserProfiles(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncUserProfilesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncUserProfilesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncUserProfilesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncUserProfilesWithStreamingResponse(self)

    async def create(
        self,
        *,
        external_id: Optional[str] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfile:
        """
        Create User Profile

        Args:
          external_id: Platform's own identifier for this user. Not enforced unique. Maximum 255
              characters.

          metadata: Free-form key-value data to attach to this user profile. Maximum 16 keys, with
              keys up to 64 characters and values up to 512 characters. Values must be
              non-empty strings.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return await self._post(
            "/v1/user_profiles?beta=true",
            body=await async_maybe_transform(
                {
                    "external_id": external_id,
                    "metadata": metadata,
                },
                user_profile_create_params.UserProfileCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfile,
        )

    async def retrieve(
        self,
        user_profile_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfile:
        """
        Get User Profile

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not user_profile_id:
            raise ValueError(f"Expected a non-empty value for `user_profile_id` but received {user_profile_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return await self._get(
            path_template("/v1/user_profiles/{user_profile_id}?beta=true", user_profile_id=user_profile_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfile,
        )

    async def update(
        self,
        user_profile_id: str,
        *,
        external_id: Optional[str] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfile:
        """
        Update User Profile

        Args:
          external_id: If present, replaces the stored external_id. Omit to leave unchanged. Maximum
              255 characters.

          metadata: Key-value pairs to merge into the stored metadata. Keys provided overwrite
              existing values. To remove a key, set its value to an empty string. Keys not
              provided are left unchanged. Maximum 16 keys, with keys up to 64 characters and
              values up to 512 characters.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not user_profile_id:
            raise ValueError(f"Expected a non-empty value for `user_profile_id` but received {user_profile_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return await self._post(
            path_template("/v1/user_profiles/{user_profile_id}?beta=true", user_profile_id=user_profile_id),
            body=await async_maybe_transform(
                {
                    "external_id": external_id,
                    "metadata": metadata,
                },
                user_profile_update_params.UserProfileUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfile,
        )

    def list(
        self,
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
    ) -> AsyncPaginator[BetaUserProfile, AsyncPageCursor[BetaUserProfile]]:
        """
        List User Profiles

        Args:
          limit: Query parameter for limit

          order: Query parameter for order

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
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return self._get_api_list(
            "/v1/user_profiles?beta=true",
            page=AsyncPageCursor[BetaUserProfile],
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
                    user_profile_list_params.UserProfileListParams,
                ),
            ),
            model=BetaUserProfile,
        )

    async def create_enrollment_url(
        self,
        user_profile_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaUserProfileEnrollmentURL:
        """
        Create Enrollment URL

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not user_profile_id:
            raise ValueError(f"Expected a non-empty value for `user_profile_id` but received {user_profile_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["user-profiles-2026-03-24"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "user-profiles-2026-03-24", **(extra_headers or {})}
        return await self._post(
            path_template(
                "/v1/user_profiles/{user_profile_id}/enrollment_url?beta=true", user_profile_id=user_profile_id
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaUserProfileEnrollmentURL,
        )


class UserProfilesWithRawResponse:
    def __init__(self, user_profiles: UserProfiles) -> None:
        self._user_profiles = user_profiles

        self.create = _legacy_response.to_raw_response_wrapper(
            user_profiles.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            user_profiles.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            user_profiles.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            user_profiles.list,
        )
        self.create_enrollment_url = _legacy_response.to_raw_response_wrapper(
            user_profiles.create_enrollment_url,
        )


class AsyncUserProfilesWithRawResponse:
    def __init__(self, user_profiles: AsyncUserProfiles) -> None:
        self._user_profiles = user_profiles

        self.create = _legacy_response.async_to_raw_response_wrapper(
            user_profiles.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            user_profiles.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            user_profiles.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            user_profiles.list,
        )
        self.create_enrollment_url = _legacy_response.async_to_raw_response_wrapper(
            user_profiles.create_enrollment_url,
        )


class UserProfilesWithStreamingResponse:
    def __init__(self, user_profiles: UserProfiles) -> None:
        self._user_profiles = user_profiles

        self.create = to_streamed_response_wrapper(
            user_profiles.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            user_profiles.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            user_profiles.update,
        )
        self.list = to_streamed_response_wrapper(
            user_profiles.list,
        )
        self.create_enrollment_url = to_streamed_response_wrapper(
            user_profiles.create_enrollment_url,
        )


class AsyncUserProfilesWithStreamingResponse:
    def __init__(self, user_profiles: AsyncUserProfiles) -> None:
        self._user_profiles = user_profiles

        self.create = async_to_streamed_response_wrapper(
            user_profiles.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            user_profiles.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            user_profiles.update,
        )
        self.list = async_to_streamed_response_wrapper(
            user_profiles.list,
        )
        self.create_enrollment_url = async_to_streamed_response_wrapper(
            user_profiles.create_enrollment_url,
        )
