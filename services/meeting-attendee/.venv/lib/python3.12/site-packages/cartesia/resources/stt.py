# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Mapping, Optional, cast
from typing_extensions import Literal

import httpx

from ..types import stt_transcribe_params
from .._types import Body, Omit, Query, Headers, NotGiven, FileTypes, omit, not_given
from .._utils import extract_files, maybe_transform, deepcopy_minimal, async_maybe_transform
from .._compat import cached_property
from .._resource import SyncAPIResource, AsyncAPIResource
from .._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from .._base_client import make_request_options
from ..types.stt_transcribe_response import SttTranscribeResponse

__all__ = ["SttResource", "AsyncSttResource"]


class SttResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> SttResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return SttResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> SttResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return SttResourceWithStreamingResponse(self)

    def transcribe(
        self,
        *,
        encoding: Optional[Literal["pcm_s16le", "pcm_s32le", "pcm_f16le", "pcm_f32le", "pcm_mulaw", "pcm_alaw"]]
        | Omit = omit,
        sample_rate: Optional[int] | Omit = omit,
        file: FileTypes | Omit = omit,
        language: Optional[
            Literal[
                "en",
                "zh",
                "de",
                "es",
                "ru",
                "ko",
                "fr",
                "ja",
                "pt",
                "tr",
                "pl",
                "ca",
                "nl",
                "ar",
                "sv",
                "it",
                "id",
                "hi",
                "fi",
                "vi",
                "he",
                "uk",
                "el",
                "ms",
                "cs",
                "ro",
                "da",
                "hu",
                "ta",
                "no",
                "th",
                "ur",
                "hr",
                "bg",
                "lt",
                "la",
                "mi",
                "ml",
                "cy",
                "sk",
                "te",
                "fa",
                "lv",
                "bn",
                "sr",
                "az",
                "sl",
                "kn",
                "et",
                "mk",
                "br",
                "eu",
                "is",
                "hy",
                "ne",
                "mn",
                "bs",
                "kk",
                "sq",
                "sw",
                "gl",
                "mr",
                "pa",
                "si",
                "km",
                "sn",
                "yo",
                "so",
                "af",
                "oc",
                "ka",
                "be",
                "tg",
                "sd",
                "gu",
                "am",
                "yi",
                "lo",
                "uz",
                "fo",
                "ht",
                "ps",
                "tk",
                "nn",
                "mt",
                "sa",
                "lb",
                "my",
                "bo",
                "tl",
                "mg",
                "as",
                "tt",
                "haw",
                "ln",
                "ha",
                "ba",
                "jw",
                "su",
                "yue",
            ]
        ]
        | Omit = omit,
        model: str | Omit = omit,
        timestamp_granularities: Optional[List[Literal["word"]]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SttTranscribeResponse:
        """
        Transcribes audio files into text using Cartesia's Speech-to-Text API.

        Upload an audio file and receive a complete transcription response. Supports
        arbitrarily long audio files with automatic intelligent chunking for longer
        audio.

        **Supported audio formats:** flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav,
        webm

        **Response format:** Returns JSON with transcribed text, duration, and language.
        Include `timestamp_granularities: ["word"]` to get word-level timestamps.
        **Pricing:** Batch transcription is priced at **1 credit per 2 seconds** of
        audio processed.

        <Note>
        For migrating from the OpenAI SDK, see our [OpenAI Whisper to Cartesia Ink Migration Guide](/api-reference/stt/migrate-from-open-ai).
        </Note>

        Args:
          encoding: The encoding format to process the audio as. If not specified, the audio file
              will be decoded automatically.

              **Supported formats:**

              - `pcm_s16le` - 16-bit signed integer PCM, little-endian (recommended for best
                performance)
              - `pcm_s32le` - 32-bit signed integer PCM, little-endian
              - `pcm_f16le` - 16-bit floating point PCM, little-endian
              - `pcm_f32le` - 32-bit floating point PCM, little-endian
              - `pcm_mulaw` - 8-bit μ-law encoded PCM
              - `pcm_alaw` - 8-bit A-law encoded PCM

          sample_rate: The sample rate of the audio in Hz.

          language: The language of the input audio in ISO-639-1 format. Defaults to `en`.

          model: ID of the model to use for transcription. Use `ink-whisper` for the latest
              Cartesia Whisper model.

          timestamp_granularities: The timestamp granularities to populate for this transcription. Currently only
              `word` level timestamps are supported.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        body = deepcopy_minimal(
            {
                "file": file,
                "language": language,
                "model": model,
                "timestamp_granularities": timestamp_granularities,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["file"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return self._post(
            "/stt",
            body=maybe_transform(body, stt_transcribe_params.SttTranscribeParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "encoding": encoding,
                        "sample_rate": sample_rate,
                    },
                    stt_transcribe_params.SttTranscribeParams,
                ),
            ),
            cast_to=SttTranscribeResponse,
        )


class AsyncSttResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncSttResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncSttResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncSttResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncSttResourceWithStreamingResponse(self)

    async def transcribe(
        self,
        *,
        encoding: Optional[Literal["pcm_s16le", "pcm_s32le", "pcm_f16le", "pcm_f32le", "pcm_mulaw", "pcm_alaw"]]
        | Omit = omit,
        sample_rate: Optional[int] | Omit = omit,
        file: FileTypes | Omit = omit,
        language: Optional[
            Literal[
                "en",
                "zh",
                "de",
                "es",
                "ru",
                "ko",
                "fr",
                "ja",
                "pt",
                "tr",
                "pl",
                "ca",
                "nl",
                "ar",
                "sv",
                "it",
                "id",
                "hi",
                "fi",
                "vi",
                "he",
                "uk",
                "el",
                "ms",
                "cs",
                "ro",
                "da",
                "hu",
                "ta",
                "no",
                "th",
                "ur",
                "hr",
                "bg",
                "lt",
                "la",
                "mi",
                "ml",
                "cy",
                "sk",
                "te",
                "fa",
                "lv",
                "bn",
                "sr",
                "az",
                "sl",
                "kn",
                "et",
                "mk",
                "br",
                "eu",
                "is",
                "hy",
                "ne",
                "mn",
                "bs",
                "kk",
                "sq",
                "sw",
                "gl",
                "mr",
                "pa",
                "si",
                "km",
                "sn",
                "yo",
                "so",
                "af",
                "oc",
                "ka",
                "be",
                "tg",
                "sd",
                "gu",
                "am",
                "yi",
                "lo",
                "uz",
                "fo",
                "ht",
                "ps",
                "tk",
                "nn",
                "mt",
                "sa",
                "lb",
                "my",
                "bo",
                "tl",
                "mg",
                "as",
                "tt",
                "haw",
                "ln",
                "ha",
                "ba",
                "jw",
                "su",
                "yue",
            ]
        ]
        | Omit = omit,
        model: str | Omit = omit,
        timestamp_granularities: Optional[List[Literal["word"]]] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SttTranscribeResponse:
        """
        Transcribes audio files into text using Cartesia's Speech-to-Text API.

        Upload an audio file and receive a complete transcription response. Supports
        arbitrarily long audio files with automatic intelligent chunking for longer
        audio.

        **Supported audio formats:** flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav,
        webm

        **Response format:** Returns JSON with transcribed text, duration, and language.
        Include `timestamp_granularities: ["word"]` to get word-level timestamps.
        **Pricing:** Batch transcription is priced at **1 credit per 2 seconds** of
        audio processed.

        <Note>
        For migrating from the OpenAI SDK, see our [OpenAI Whisper to Cartesia Ink Migration Guide](/api-reference/stt/migrate-from-open-ai).
        </Note>

        Args:
          encoding: The encoding format to process the audio as. If not specified, the audio file
              will be decoded automatically.

              **Supported formats:**

              - `pcm_s16le` - 16-bit signed integer PCM, little-endian (recommended for best
                performance)
              - `pcm_s32le` - 32-bit signed integer PCM, little-endian
              - `pcm_f16le` - 16-bit floating point PCM, little-endian
              - `pcm_f32le` - 32-bit floating point PCM, little-endian
              - `pcm_mulaw` - 8-bit μ-law encoded PCM
              - `pcm_alaw` - 8-bit A-law encoded PCM

          sample_rate: The sample rate of the audio in Hz.

          language: The language of the input audio in ISO-639-1 format. Defaults to `en`.

          model: ID of the model to use for transcription. Use `ink-whisper` for the latest
              Cartesia Whisper model.

          timestamp_granularities: The timestamp granularities to populate for this transcription. Currently only
              `word` level timestamps are supported.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        body = deepcopy_minimal(
            {
                "file": file,
                "language": language,
                "model": model,
                "timestamp_granularities": timestamp_granularities,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["file"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return await self._post(
            "/stt",
            body=await async_maybe_transform(body, stt_transcribe_params.SttTranscribeParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform(
                    {
                        "encoding": encoding,
                        "sample_rate": sample_rate,
                    },
                    stt_transcribe_params.SttTranscribeParams,
                ),
            ),
            cast_to=SttTranscribeResponse,
        )


class SttResourceWithRawResponse:
    def __init__(self, stt: SttResource) -> None:
        self._stt = stt

        self.transcribe = to_raw_response_wrapper(
            stt.transcribe,
        )


class AsyncSttResourceWithRawResponse:
    def __init__(self, stt: AsyncSttResource) -> None:
        self._stt = stt

        self.transcribe = async_to_raw_response_wrapper(
            stt.transcribe,
        )


class SttResourceWithStreamingResponse:
    def __init__(self, stt: SttResource) -> None:
        self._stt = stt

        self.transcribe = to_streamed_response_wrapper(
            stt.transcribe,
        )


class AsyncSttResourceWithStreamingResponse:
    def __init__(self, stt: AsyncSttResource) -> None:
        self._stt = stt

        self.transcribe = async_to_streamed_response_wrapper(
            stt.transcribe,
        )
