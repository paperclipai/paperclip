# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Mapping, Optional, cast
from typing_extensions import Literal

import httpx

from ..types import (
    SupportedLanguage,
    GenderPresentation,
    voice_get_params,
    voice_list_params,
    voice_clone_params,
    voice_update_params,
    voice_localize_params,
)
from .._types import Body, Omit, Query, Headers, NoneType, NotGiven, FileTypes, omit, not_given
from .._utils import extract_files, maybe_transform, deepcopy_minimal, async_maybe_transform
from .._compat import cached_property
from .._resource import SyncAPIResource, AsyncAPIResource
from .._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from ..pagination import SyncCursorIDPage, AsyncCursorIDPage
from ..types.voice import Voice
from .._base_client import AsyncPaginator, make_request_options
from ..types.voice_metadata import VoiceMetadata
from ..types.supported_language import SupportedLanguage
from ..types.gender_presentation import GenderPresentation

__all__ = ["VoicesResource", "AsyncVoicesResource"]


class VoicesResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> VoicesResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return VoicesResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> VoicesResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return VoicesResourceWithStreamingResponse(self)

    def update(
        self,
        id: str,
        *,
        description: str,
        name: str,
        gender: Optional[GenderPresentation] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Voice:
        """Update the name, description, and gender of a voice.

        To set the gender back to
        the default, set the gender to `null`. If gender is not specified, the gender
        will not be updated.

        Args:
          id: The ID of the voice.

          description: The description of the voice.

          name: The name of the voice.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._patch(
            f"/voices/{id}",
            body=maybe_transform(
                {
                    "description": description,
                    "name": name,
                    "gender": gender,
                },
                voice_update_params.VoiceUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Voice,
        )

    def list(
        self,
        *,
        ending_before: Optional[str] | Omit = omit,
        expand: Optional[List[Literal["preview_file_url"]]] | Omit = omit,
        gender: Optional[GenderPresentation] | Omit = omit,
        is_owner: Optional[bool] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        q: Optional[str] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncCursorIDPage[Voice]:
        """List Voices

        Args:
          ending_before: A cursor to use in pagination.

        `ending_before` is a Voice ID that defines your
              place in the list. For example, if you make a /voices request and receive 100
              objects, starting with `voice_abc123`, your subsequent call can include
              `ending_before=voice_abc123` to fetch the previous page of the list.

          expand: Additional fields to include in the response.

          gender: The gender presentation of the voices to return.

          is_owner: Whether to only return voices owned your organization.

          limit: The number of Voices to return per page, ranging between 1 and 100.

          q: Query string to search for voices by name, description, or Voice ID.

          starting_after: A cursor to use in pagination. `starting_after` is a Voice ID that defines your
              place in the list. For example, if you make a /voices request and receive 100
              objects, ending with `voice_abc123`, your subsequent call can include
              `starting_after=voice_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/voices",
            page=SyncCursorIDPage[Voice],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "ending_before": ending_before,
                        "expand": expand,
                        "gender": gender,
                        "is_owner": is_owner,
                        "limit": limit,
                        "q": q,
                        "starting_after": starting_after,
                    },
                    voice_list_params.VoiceListParams,
                ),
            ),
            model=Voice,
        )

    def delete(
        self,
        id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """
        Delete Voice

        Args:
          id: The ID of the voice.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return self._delete(
            f"/voices/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )

    def clone(
        self,
        *,
        base_voice_id: Optional[str] | Omit = omit,
        clip: FileTypes | Omit = omit,
        description: Optional[str] | Omit = omit,
        language: SupportedLanguage | Omit = omit,
        name: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VoiceMetadata:
        """Clone a high similarity voice from an audio clip.

        Clones are more similar to the
        source clip, but may reproduce background noise. For these, use an audio clip
        about 5 seconds long.

        Args:
          base_voice_id: Optional base voice ID that the cloned voice is derived from.

          description: A description for the voice.

          language: The language of the voice.

          name: The name of the voice.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        body = deepcopy_minimal(
            {
                "base_voice_id": base_voice_id,
                "clip": clip,
                "description": description,
                "language": language,
                "name": name,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["clip"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return self._post(
            "/voices/clone",
            body=maybe_transform(body, voice_clone_params.VoiceCloneParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VoiceMetadata,
        )

    def get(
        self,
        id: str,
        *,
        expand: Optional[List[Literal["preview_file_url"]]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Voice:
        """
        Get Voice

        Args:
          id: The ID of the voice.

          expand: Additional fields to include in the response.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return self._get(
            f"/voices/{id}",
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform({"expand": expand}, voice_get_params.VoiceGetParams),
            ),
            cast_to=Voice,
        )

    def localize(
        self,
        *,
        description: str,
        language: Literal["en", "de", "es", "fr", "ja", "pt", "zh", "hi", "it", "ko", "nl", "pl", "ru", "sv", "tr"],
        name: str,
        original_speaker_gender: Literal["male", "female"],
        voice_id: str,
        dialect: Optional[Literal["au", "in", "so", "uk", "us", "mx", "pe", "br", "eu", "ca"]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VoiceMetadata:
        """
        Create a new voice from an existing voice localized to a new language and
        dialect.

        Args:
          description: The description of the new localized voice.

          language: Target language to localize the voice to.

              Options: English (en), German (de), Spanish (es), French (fr), Japanese (ja),
              Portuguese (pt), Chinese (zh), Hindi (hi), Italian (it), Korean (ko), Dutch
              (nl), Polish (pl), Russian (ru), Swedish (sv), Turkish (tr).

          name: The name of the new localized voice.

          voice_id: The ID of the voice to localize.

          dialect: The dialect to localize to. Only supported for English (`en`), Spanish (`es`),
              Portuguese (`pt`), and French (`fr`).

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._post(
            "/voices/localize",
            body=maybe_transform(
                {
                    "description": description,
                    "language": language,
                    "name": name,
                    "original_speaker_gender": original_speaker_gender,
                    "voice_id": voice_id,
                    "dialect": dialect,
                },
                voice_localize_params.VoiceLocalizeParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VoiceMetadata,
        )


class AsyncVoicesResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncVoicesResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncVoicesResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncVoicesResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncVoicesResourceWithStreamingResponse(self)

    async def update(
        self,
        id: str,
        *,
        description: str,
        name: str,
        gender: Optional[GenderPresentation] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Voice:
        """Update the name, description, and gender of a voice.

        To set the gender back to
        the default, set the gender to `null`. If gender is not specified, the gender
        will not be updated.

        Args:
          id: The ID of the voice.

          description: The description of the voice.

          name: The name of the voice.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return await self._patch(
            f"/voices/{id}",
            body=await async_maybe_transform(
                {
                    "description": description,
                    "name": name,
                    "gender": gender,
                },
                voice_update_params.VoiceUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Voice,
        )

    def list(
        self,
        *,
        ending_before: Optional[str] | Omit = omit,
        expand: Optional[List[Literal["preview_file_url"]]] | Omit = omit,
        gender: Optional[GenderPresentation] | Omit = omit,
        is_owner: Optional[bool] | Omit = omit,
        limit: Optional[int] | Omit = omit,
        q: Optional[str] | Omit = omit,
        starting_after: Optional[str] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[Voice, AsyncCursorIDPage[Voice]]:
        """List Voices

        Args:
          ending_before: A cursor to use in pagination.

        `ending_before` is a Voice ID that defines your
              place in the list. For example, if you make a /voices request and receive 100
              objects, starting with `voice_abc123`, your subsequent call can include
              `ending_before=voice_abc123` to fetch the previous page of the list.

          expand: Additional fields to include in the response.

          gender: The gender presentation of the voices to return.

          is_owner: Whether to only return voices owned your organization.

          limit: The number of Voices to return per page, ranging between 1 and 100.

          q: Query string to search for voices by name, description, or Voice ID.

          starting_after: A cursor to use in pagination. `starting_after` is a Voice ID that defines your
              place in the list. For example, if you make a /voices request and receive 100
              objects, ending with `voice_abc123`, your subsequent call can include
              `starting_after=voice_abc123` to fetch the next page of the list.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return self._get_api_list(
            "/voices",
            page=AsyncCursorIDPage[Voice],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "ending_before": ending_before,
                        "expand": expand,
                        "gender": gender,
                        "is_owner": is_owner,
                        "limit": limit,
                        "q": q,
                        "starting_after": starting_after,
                    },
                    voice_list_params.VoiceListParams,
                ),
            ),
            model=Voice,
        )

    async def delete(
        self,
        id: str,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """
        Delete Voice

        Args:
          id: The ID of the voice.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        return await self._delete(
            f"/voices/{id}",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )

    async def clone(
        self,
        *,
        base_voice_id: Optional[str] | Omit = omit,
        clip: FileTypes | Omit = omit,
        description: Optional[str] | Omit = omit,
        language: SupportedLanguage | Omit = omit,
        name: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VoiceMetadata:
        """Clone a high similarity voice from an audio clip.

        Clones are more similar to the
        source clip, but may reproduce background noise. For these, use an audio clip
        about 5 seconds long.

        Args:
          base_voice_id: Optional base voice ID that the cloned voice is derived from.

          description: A description for the voice.

          language: The language of the voice.

          name: The name of the voice.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        body = deepcopy_minimal(
            {
                "base_voice_id": base_voice_id,
                "clip": clip,
                "description": description,
                "language": language,
                "name": name,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["clip"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return await self._post(
            "/voices/clone",
            body=await async_maybe_transform(body, voice_clone_params.VoiceCloneParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VoiceMetadata,
        )

    async def get(
        self,
        id: str,
        *,
        expand: Optional[List[Literal["preview_file_url"]]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Voice:
        """
        Get Voice

        Args:
          id: The ID of the voice.

          expand: Additional fields to include in the response.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not id:
            raise ValueError(f"Expected a non-empty value for `id` but received {id!r}")
        return await self._get(
            f"/voices/{id}",
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform({"expand": expand}, voice_get_params.VoiceGetParams),
            ),
            cast_to=Voice,
        )

    async def localize(
        self,
        *,
        description: str,
        language: Literal["en", "de", "es", "fr", "ja", "pt", "zh", "hi", "it", "ko", "nl", "pl", "ru", "sv", "tr"],
        name: str,
        original_speaker_gender: Literal["male", "female"],
        voice_id: str,
        dialect: Optional[Literal["au", "in", "so", "uk", "us", "mx", "pe", "br", "eu", "ca"]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> VoiceMetadata:
        """
        Create a new voice from an existing voice localized to a new language and
        dialect.

        Args:
          description: The description of the new localized voice.

          language: Target language to localize the voice to.

              Options: English (en), German (de), Spanish (es), French (fr), Japanese (ja),
              Portuguese (pt), Chinese (zh), Hindi (hi), Italian (it), Korean (ko), Dutch
              (nl), Polish (pl), Russian (ru), Swedish (sv), Turkish (tr).

          name: The name of the new localized voice.

          voice_id: The ID of the voice to localize.

          dialect: The dialect to localize to. Only supported for English (`en`), Spanish (`es`),
              Portuguese (`pt`), and French (`fr`).

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        return await self._post(
            "/voices/localize",
            body=await async_maybe_transform(
                {
                    "description": description,
                    "language": language,
                    "name": name,
                    "original_speaker_gender": original_speaker_gender,
                    "voice_id": voice_id,
                    "dialect": dialect,
                },
                voice_localize_params.VoiceLocalizeParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=VoiceMetadata,
        )


class VoicesResourceWithRawResponse:
    def __init__(self, voices: VoicesResource) -> None:
        self._voices = voices

        self.update = to_raw_response_wrapper(
            voices.update,
        )
        self.list = to_raw_response_wrapper(
            voices.list,
        )
        self.delete = to_raw_response_wrapper(
            voices.delete,
        )
        self.clone = to_raw_response_wrapper(
            voices.clone,
        )
        self.get = to_raw_response_wrapper(
            voices.get,
        )
        self.localize = to_raw_response_wrapper(
            voices.localize,
        )


class AsyncVoicesResourceWithRawResponse:
    def __init__(self, voices: AsyncVoicesResource) -> None:
        self._voices = voices

        self.update = async_to_raw_response_wrapper(
            voices.update,
        )
        self.list = async_to_raw_response_wrapper(
            voices.list,
        )
        self.delete = async_to_raw_response_wrapper(
            voices.delete,
        )
        self.clone = async_to_raw_response_wrapper(
            voices.clone,
        )
        self.get = async_to_raw_response_wrapper(
            voices.get,
        )
        self.localize = async_to_raw_response_wrapper(
            voices.localize,
        )


class VoicesResourceWithStreamingResponse:
    def __init__(self, voices: VoicesResource) -> None:
        self._voices = voices

        self.update = to_streamed_response_wrapper(
            voices.update,
        )
        self.list = to_streamed_response_wrapper(
            voices.list,
        )
        self.delete = to_streamed_response_wrapper(
            voices.delete,
        )
        self.clone = to_streamed_response_wrapper(
            voices.clone,
        )
        self.get = to_streamed_response_wrapper(
            voices.get,
        )
        self.localize = to_streamed_response_wrapper(
            voices.localize,
        )


class AsyncVoicesResourceWithStreamingResponse:
    def __init__(self, voices: AsyncVoicesResource) -> None:
        self._voices = voices

        self.update = async_to_streamed_response_wrapper(
            voices.update,
        )
        self.list = async_to_streamed_response_wrapper(
            voices.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            voices.delete,
        )
        self.clone = async_to_streamed_response_wrapper(
            voices.clone,
        )
        self.get = async_to_streamed_response_wrapper(
            voices.get,
        )
        self.localize = async_to_streamed_response_wrapper(
            voices.localize,
        )
