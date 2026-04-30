# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Mapping, Optional, cast
from typing_extensions import Literal

import httpx

from ..types import (
    RawEncoding,
    OutputFormatContainer,
    voice_changer_change_voice_sse_params,
    voice_changer_change_voice_bytes_params,
)
from .._types import Body, Omit, Query, Headers, NoneType, NotGiven, FileTypes, omit, not_given
from .._utils import extract_files, maybe_transform, deepcopy_minimal, async_maybe_transform
from .._compat import cached_property
from .._resource import SyncAPIResource, AsyncAPIResource
from .._response import (
    BinaryAPIResponse,
    AsyncBinaryAPIResponse,
    StreamedBinaryAPIResponse,
    AsyncStreamedBinaryAPIResponse,
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    to_custom_raw_response_wrapper,
    async_to_streamed_response_wrapper,
    to_custom_streamed_response_wrapper,
    async_to_custom_raw_response_wrapper,
    async_to_custom_streamed_response_wrapper,
)
from .._base_client import make_request_options
from ..types.raw_encoding import RawEncoding
from ..types.output_format_container import OutputFormatContainer

__all__ = ["VoiceChangerResource", "AsyncVoiceChangerResource"]


class VoiceChangerResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> VoiceChangerResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return VoiceChangerResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> VoiceChangerResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return VoiceChangerResourceWithStreamingResponse(self)

    def change_voice_bytes(
        self,
        *,
        clip: FileTypes | Omit = omit,
        output_format_bit_rate: Optional[int] | Omit = omit,
        output_format_container: OutputFormatContainer | Omit = omit,
        output_format_encoding: Optional[RawEncoding] | Omit = omit,
        output_format_sample_rate: Literal[8000, 16000, 22050, 24000, 44100, 48000] | Omit = omit,
        voice_id: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BinaryAPIResponse:
        """
        Takes an audio file of speech, and returns an audio file of speech spoken with
        the same intonation, but with a different voice.

        This endpoint is priced at 15 characters per second of input audio.

        Args:
          output_format_bit_rate: Required for `mp3` containers.

          output_format_encoding: Required for `raw` and `wav` containers.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "audio/wav", **(extra_headers or {})}
        body = deepcopy_minimal(
            {
                "clip": clip,
                "output_format_bit_rate": output_format_bit_rate,
                "output_format_container": output_format_container,
                "output_format_encoding": output_format_encoding,
                "output_format_sample_rate": output_format_sample_rate,
                "voice_id": voice_id,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["clip"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return self._post(
            "/voice-changer/bytes",
            body=maybe_transform(body, voice_changer_change_voice_bytes_params.VoiceChangerChangeVoiceBytesParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BinaryAPIResponse,
        )

    def change_voice_sse(
        self,
        *,
        clip: FileTypes | Omit = omit,
        output_format_bit_rate: Optional[int] | Omit = omit,
        output_format_container: OutputFormatContainer | Omit = omit,
        output_format_encoding: Optional[RawEncoding] | Omit = omit,
        output_format_sample_rate: Literal[8000, 16000, 22050, 24000, 44100, 48000] | Omit = omit,
        voice_id: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """
        Voice Changer (SSE)

        Args:
          output_format_bit_rate: Required for `mp3` containers.

          output_format_encoding: Required for `raw` and `wav` containers.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        body = deepcopy_minimal(
            {
                "clip": clip,
                "output_format_bit_rate": output_format_bit_rate,
                "output_format_container": output_format_container,
                "output_format_encoding": output_format_encoding,
                "output_format_sample_rate": output_format_sample_rate,
                "voice_id": voice_id,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["clip"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers["Content-Type"] = "multipart/form-data"
        return self._post(
            "/voice-changer/sse",
            body=maybe_transform(body, voice_changer_change_voice_sse_params.VoiceChangerChangeVoiceSseParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )


class AsyncVoiceChangerResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncVoiceChangerResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncVoiceChangerResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncVoiceChangerResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncVoiceChangerResourceWithStreamingResponse(self)

    async def change_voice_bytes(
        self,
        *,
        clip: FileTypes | Omit = omit,
        output_format_bit_rate: Optional[int] | Omit = omit,
        output_format_container: OutputFormatContainer | Omit = omit,
        output_format_encoding: Optional[RawEncoding] | Omit = omit,
        output_format_sample_rate: Literal[8000, 16000, 22050, 24000, 44100, 48000] | Omit = omit,
        voice_id: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncBinaryAPIResponse:
        """
        Takes an audio file of speech, and returns an audio file of speech spoken with
        the same intonation, but with a different voice.

        This endpoint is priced at 15 characters per second of input audio.

        Args:
          output_format_bit_rate: Required for `mp3` containers.

          output_format_encoding: Required for `raw` and `wav` containers.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "audio/wav", **(extra_headers or {})}
        body = deepcopy_minimal(
            {
                "clip": clip,
                "output_format_bit_rate": output_format_bit_rate,
                "output_format_container": output_format_container,
                "output_format_encoding": output_format_encoding,
                "output_format_sample_rate": output_format_sample_rate,
                "voice_id": voice_id,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["clip"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return await self._post(
            "/voice-changer/bytes",
            body=await async_maybe_transform(
                body, voice_changer_change_voice_bytes_params.VoiceChangerChangeVoiceBytesParams
            ),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=AsyncBinaryAPIResponse,
        )

    async def change_voice_sse(
        self,
        *,
        clip: FileTypes | Omit = omit,
        output_format_bit_rate: Optional[int] | Omit = omit,
        output_format_container: OutputFormatContainer | Omit = omit,
        output_format_encoding: Optional[RawEncoding] | Omit = omit,
        output_format_sample_rate: Literal[8000, 16000, 22050, 24000, 44100, 48000] | Omit = omit,
        voice_id: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> None:
        """
        Voice Changer (SSE)

        Args:
          output_format_bit_rate: Required for `mp3` containers.

          output_format_encoding: Required for `raw` and `wav` containers.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        body = deepcopy_minimal(
            {
                "clip": clip,
                "output_format_bit_rate": output_format_bit_rate,
                "output_format_container": output_format_container,
                "output_format_encoding": output_format_encoding,
                "output_format_sample_rate": output_format_sample_rate,
                "voice_id": voice_id,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["clip"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers["Content-Type"] = "multipart/form-data"
        return await self._post(
            "/voice-changer/sse",
            body=await async_maybe_transform(
                body, voice_changer_change_voice_sse_params.VoiceChangerChangeVoiceSseParams
            ),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=NoneType,
        )


class VoiceChangerResourceWithRawResponse:
    def __init__(self, voice_changer: VoiceChangerResource) -> None:
        self._voice_changer = voice_changer

        self.change_voice_bytes = to_custom_raw_response_wrapper(
            voice_changer.change_voice_bytes,
            BinaryAPIResponse,
        )
        self.change_voice_sse = to_raw_response_wrapper(
            voice_changer.change_voice_sse,
        )


class AsyncVoiceChangerResourceWithRawResponse:
    def __init__(self, voice_changer: AsyncVoiceChangerResource) -> None:
        self._voice_changer = voice_changer

        self.change_voice_bytes = async_to_custom_raw_response_wrapper(
            voice_changer.change_voice_bytes,
            AsyncBinaryAPIResponse,
        )
        self.change_voice_sse = async_to_raw_response_wrapper(
            voice_changer.change_voice_sse,
        )


class VoiceChangerResourceWithStreamingResponse:
    def __init__(self, voice_changer: VoiceChangerResource) -> None:
        self._voice_changer = voice_changer

        self.change_voice_bytes = to_custom_streamed_response_wrapper(
            voice_changer.change_voice_bytes,
            StreamedBinaryAPIResponse,
        )
        self.change_voice_sse = to_streamed_response_wrapper(
            voice_changer.change_voice_sse,
        )


class AsyncVoiceChangerResourceWithStreamingResponse:
    def __init__(self, voice_changer: AsyncVoiceChangerResource) -> None:
        self._voice_changer = voice_changer

        self.change_voice_bytes = async_to_custom_streamed_response_wrapper(
            voice_changer.change_voice_bytes,
            AsyncStreamedBinaryAPIResponse,
        )
        self.change_voice_sse = async_to_streamed_response_wrapper(
            voice_changer.change_voice_sse,
        )
