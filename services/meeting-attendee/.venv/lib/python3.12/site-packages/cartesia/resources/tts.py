# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

import json
import uuid
import queue
import logging
from types import TracebackType
from typing import TYPE_CHECKING, Any, Dict, Mapping, Iterator, Optional, cast
from typing_extensions import AsyncIterator, deprecated

import httpx
from pydantic import BaseModel

from ..types import (
    ModelSpeed,
    SupportedLanguage,
    tts_infill_params,
    tts_generate_params,
    tts_generate_sse_params,
)
from .._types import Body, Omit, Query, Headers, NotGiven, FileTypes, omit, not_given
from .._utils import extract_files, maybe_transform, deepcopy_minimal, async_maybe_transform
from .._compat import cached_property
from .._models import construct_type_unchecked
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
from .._streaming import SSEEventStream, AsyncSSEEventStream
from .._exceptions import CartesiaError
from .._base_client import _merge_mappings, make_request_options
from ..types.model_speed import ModelSpeed
from ..types.supported_language import SupportedLanguage
from ..types.websocket_response import WebsocketResponse
from ..types.voice_specifier_param import VoiceSpecifierParam
from ..types.websocket_client_event import GenerationRequest, CancelContextRequest, WebsocketClientEvent
from ..types.generation_config_param import GenerationConfigParam
from ..types.websocket_client_event_param import WebsocketClientEventParam
from ..types.websocket_connection_options import WebsocketConnectionOptions

if TYPE_CHECKING:
    import asyncio

    from websockets.sync.client import ClientConnection as WebsocketConnection
    from websockets.asyncio.client import ClientConnection as AsyncWebsocketConnection

    from .._client import Cartesia, AsyncCartesia

__all__ = ["TTSResource", "AsyncTTSResource"]

log: logging.Logger = logging.getLogger(__name__)


class TTSResource(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> TTSResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return TTSResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> TTSResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return TTSResourceWithStreamingResponse(self)

    def generate(
        self,
        *,
        model_id: str,
        output_format: tts_generate_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        generation_config: GenerationConfigParam | Omit = omit,
        language: Optional[SupportedLanguage] | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        save: Optional[bool] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BinaryAPIResponse:
        """
        Text to Speech (Bytes)

        Args:
          model_id: The ID of the model to use for the generation. See
              [Models](/build-with-cartesia/tts-models) for available models.

          generation_config: Configure the various attributes of the generated speech. These are only for
              `sonic-3` and have no effect on earlier models.

              See
              [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
              for a guide on this option.

          language: The language that the given voice should speak the transcript in. For valid
              options, see [Models](/build-with-cartesia/tts-models).

          pronunciation_dict_id: The ID of a pronunciation dictionary to use for the generation. Pronunciation
              dictionaries are supported by `sonic-3` models and newer.

          save: Whether to save the generated audio file. When true, the response will include a
              `Cartesia-File-ID` header.

          speed: Use `generation_config.speed` for sonic-3. Speed setting for the model. Defaults
              to `normal`. This feature is experimental and may not work for all voices.
              Influences the speed of the generated speech. Faster speeds may reduce
              hallucination rate.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "audio/wav", **(extra_headers or {})}
        return self._post(
            "/tts/bytes",
            body=maybe_transform(
                {
                    "model_id": model_id,
                    "output_format": output_format,
                    "transcript": transcript,
                    "voice": voice,
                    "generation_config": generation_config,
                    "language": language,
                    "pronunciation_dict_id": pronunciation_dict_id,
                    "save": save,
                    "speed": speed,
                },
                tts_generate_params.TTSGenerateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BinaryAPIResponse,
        )

    def generate_sse(
        self,
        *,
        model_id: str,
        output_format: tts_generate_sse_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        add_phoneme_timestamps: Optional[bool] | Omit = omit,
        add_timestamps: Optional[bool] | Omit = omit,
        context_id: Optional[str] | Omit = omit,
        generation_config: GenerationConfigParam | Omit = omit,
        language: SupportedLanguage | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        use_normalized_timestamps: Optional[bool] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SSEEventStream:
        """
        Text to Speech (SSE)

        Args:
          model_id: The ID of the model to use for the generation. See
              [Models](/build-with-cartesia/tts-models) for available models.

          add_phoneme_timestamps: Whether to return phoneme-level timestamps. If `false` (default), no phoneme
              timestamps will be produced. If `true`, the server will return timestamp events
              containing phoneme-level timing information.

          add_timestamps: Whether to return word-level timestamps. If `false` (default), no word
              timestamps will be produced at all. If `true`, the server will return timestamp
              events containing word-level timing information.

          context_id: Optional context ID for this request.

          generation_config: Configure the various attributes of the generated speech. These are only for
              `sonic-3` and have no effect on earlier models.

              See
              [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
              for a guide on this option.

          language: The language that the given voice should speak the transcript in. For valid
              options, see [Models](/build-with-cartesia/tts-models).

          pronunciation_dict_id: The ID of a pronunciation dictionary to use for the generation. Pronunciation
              dictionaries are supported by `sonic-3` models and newer.

          speed: Use `generation_config.speed` for sonic-3. Speed setting for the model. Defaults
              to `normal`. This feature is experimental and may not work for all voices.
              Influences the speed of the generated speech. Faster speeds may reduce
              hallucination rate.

          use_normalized_timestamps: Whether to use normalized timestamps (True) or original timestamps (False).

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        response = self._post(
            "/tts/sse",
            body=maybe_transform(
                {
                    "model_id": model_id,
                    "output_format": output_format,
                    "transcript": transcript,
                    "voice": voice,
                    "add_phoneme_timestamps": add_phoneme_timestamps,
                    "add_timestamps": add_timestamps,
                    "context_id": context_id,
                    "generation_config": generation_config,
                    "language": language,
                    "pronunciation_dict_id": pronunciation_dict_id,
                    "speed": speed,
                    "use_normalized_timestamps": use_normalized_timestamps,
                },
                tts_generate_sse_params.TTSGenerateSseParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=httpx.Response,
        )
        return SSEEventStream(response=response, client=self._client)

    @deprecated("Use .generate_sse() instead")
    def sse(
        self,
        *,
        model_id: str,
        output_format: tts_generate_sse_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        add_phoneme_timestamps: Optional[bool] | Omit = omit,
        add_timestamps: Optional[bool] | Omit = omit,
        context_id: Optional[str] | Omit = omit,
        generation_config: GenerationConfigParam | Omit = omit,
        language: SupportedLanguage | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        use_normalized_timestamps: Optional[bool] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SSEEventStream:
        """
        Text to Speech (SSE) - Backward compatibility wrapper for generate_sse().
        """
        return self.generate_sse(
            model_id=model_id,
            output_format=output_format,
            transcript=transcript,
            voice=voice,
            add_phoneme_timestamps=add_phoneme_timestamps,
            add_timestamps=add_timestamps,
            context_id=context_id,
            generation_config=generation_config,
            language=language,
            pronunciation_dict_id=pronunciation_dict_id,
            speed=speed,
            use_normalized_timestamps=use_normalized_timestamps,
            extra_headers=extra_headers,
            extra_query=extra_query,
            extra_body=extra_body,
            timeout=timeout,
        )

    @deprecated("Use .websocket_connect() instead")
    def websocket(
        self,
        extra_query: Query = {},
        extra_headers: Headers = {},
        websocket_connection_options: WebsocketConnectionOptions = {},
    ) -> BackcompatTTSResourceConnection:
        """Create a WebSocket connection for real-time TTS streaming (v2 compatible)."""
        manager = self.websocket_connect(
            extra_query=extra_query,
            extra_headers=extra_headers,
            websocket_connection_options=websocket_connection_options,
        )
        return BackcompatTTSResourceConnection(manager)

    @deprecated("Use .generate() instead")
    def bytes(
        self,
        *,
        model_id: str,
        output_format: tts_generate_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        duration: Optional[float] | Omit = omit,  # noqa: ARG002
        generation_config: GenerationConfigParam | Omit = omit,
        language: Optional[SupportedLanguage] | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        save: Optional[bool] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Iterator[bytes]:
        """Text to Speech returning an iterator of audio bytes.

        This is a convenience wrapper around generate() that returns an iterator
        directly, allowing you to iterate over chunks without calling .iter_bytes().
        """
        response = self.generate(
            model_id=model_id,
            output_format=output_format,
            transcript=transcript,
            voice=voice,
            generation_config=generation_config,
            language=language,
            pronunciation_dict_id=pronunciation_dict_id,
            save=save,
            speed=speed,
            extra_headers=extra_headers,
            extra_query=extra_query,
            extra_body=extra_body,
            timeout=timeout,
        )
        return response.iter_bytes()

    def infill(
        self,
        *,
        language: str | Omit = omit,
        left_audio: FileTypes | Omit = omit,
        model_id: str | Omit = omit,
        output_format: tts_infill_params.OutputFormat | Omit = omit,
        right_audio: FileTypes | Omit = omit,
        transcript: str | Omit = omit,
        voice_id: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BinaryAPIResponse:
        """Generate audio that smoothly connects two existing audio segments.

        This is
        useful for inserting new speech between existing speech segments while
        maintaining natural transitions.

        **The cost is 1 credit per character of the infill text plus a fixed cost of 300
        credits.**

        At least one of `left_audio` or `right_audio` must be provided.

        As with all generative models, there's some inherent variability, but here's
        some tips we recommend to get the best results from infill:

        - Use longer infill transcripts
          - This gives the model more flexibility to adapt to the rest of the audio
        - Target natural pauses in the audio when deciding where to clip
          - This means you don't need word-level timestamps to be as precise
        - Clip right up to the start and end of the audio segment you want infilled,
          keeping as much silence in the left/right audio segments as possible
          - This helps the model generate more natural transitions

        Args:
          language: The language of the transcript

          model_id: The ID of the model to use for generating audio. Any model other than the first
              `"sonic"` model is supported.

          transcript: The infill text to generate

          voice_id: The ID of the voice to use for generating audio

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "audio/wav", **(extra_headers or {})}
        body = deepcopy_minimal(
            {
                "language": language,
                "left_audio": left_audio,
                "model_id": model_id,
                "output_format": output_format,
                "right_audio": right_audio,
                "transcript": transcript,
                "voice_id": voice_id,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["left_audio"], ["right_audio"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return self._post(
            "/infill/bytes",
            body=maybe_transform(body, tts_infill_params.TTSInfillParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BinaryAPIResponse,
        )

    def websocket_connect(
        self,
        extra_query: Query = {},
        extra_headers: Headers = {},
        websocket_connection_options: WebsocketConnectionOptions = {},
    ) -> TTSResourceConnectionManager:
        return TTSResourceConnectionManager(
            client=self._client,
            extra_query=extra_query,
            extra_headers=extra_headers,
            websocket_connection_options=websocket_connection_options,
        )


class AsyncTTSResource(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncTTSResourceWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#accessing-raw-response-data-eg-headers
        """
        return AsyncTTSResourceWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncTTSResourceWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/cartesia-ai/cartesia-python#with_streaming_response
        """
        return AsyncTTSResourceWithStreamingResponse(self)

    async def generate(
        self,
        *,
        model_id: str,
        output_format: tts_generate_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        generation_config: GenerationConfigParam | Omit = omit,
        language: Optional[SupportedLanguage] | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        save: Optional[bool] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncBinaryAPIResponse:
        """
        Text to Speech (Bytes)

        Args:
          model_id: The ID of the model to use for the generation. See
              [Models](/build-with-cartesia/tts-models) for available models.

          generation_config: Configure the various attributes of the generated speech. These are only for
              `sonic-3` and have no effect on earlier models.

              See
              [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
              for a guide on this option.

          language: The language that the given voice should speak the transcript in. For valid
              options, see [Models](/build-with-cartesia/tts-models).

          pronunciation_dict_id: The ID of a pronunciation dictionary to use for the generation. Pronunciation
              dictionaries are supported by `sonic-3` models and newer.

          save: Whether to save the generated audio file. When true, the response will include a
              `Cartesia-File-ID` header.

          speed: Use `generation_config.speed` for sonic-3. Speed setting for the model. Defaults
              to `normal`. This feature is experimental and may not work for all voices.
              Influences the speed of the generated speech. Faster speeds may reduce
              hallucination rate.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "audio/wav", **(extra_headers or {})}
        return await self._post(
            "/tts/bytes",
            body=await async_maybe_transform(
                {
                    "model_id": model_id,
                    "output_format": output_format,
                    "transcript": transcript,
                    "voice": voice,
                    "generation_config": generation_config,
                    "language": language,
                    "pronunciation_dict_id": pronunciation_dict_id,
                    "save": save,
                    "speed": speed,
                },
                tts_generate_params.TTSGenerateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=AsyncBinaryAPIResponse,
        )

    async def generate_sse(
        self,
        *,
        model_id: str,
        output_format: tts_generate_sse_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        add_phoneme_timestamps: Optional[bool] | Omit = omit,
        add_timestamps: Optional[bool] | Omit = omit,
        context_id: Optional[str] | Omit = omit,
        generation_config: GenerationConfigParam | Omit = omit,
        language: SupportedLanguage | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        use_normalized_timestamps: Optional[bool] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncSSEEventStream:
        """
        Text to Speech (SSE)

        Args:
          model_id: The ID of the model to use for the generation. See
              [Models](/build-with-cartesia/tts-models) for available models.

          add_phoneme_timestamps: Whether to return phoneme-level timestamps. If `false` (default), no phoneme
              timestamps will be produced. If `true`, the server will return timestamp events
              containing phoneme-level timing information.

          add_timestamps: Whether to return word-level timestamps. If `false` (default), no word
              timestamps will be produced at all. If `true`, the server will return timestamp
              events containing word-level timing information.

          context_id: Optional context ID for this request.

          generation_config: Configure the various attributes of the generated speech. These are only for
              `sonic-3` and have no effect on earlier models.

              See
              [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
              for a guide on this option.

          language: The language that the given voice should speak the transcript in. For valid
              options, see [Models](/build-with-cartesia/tts-models).

          pronunciation_dict_id: The ID of a pronunciation dictionary to use for the generation. Pronunciation
              dictionaries are supported by `sonic-3` models and newer.

          speed: Use `generation_config.speed` for sonic-3. Speed setting for the model. Defaults
              to `normal`. This feature is experimental and may not work for all voices.
              Influences the speed of the generated speech. Faster speeds may reduce
              hallucination rate.

          use_normalized_timestamps: Whether to use normalized timestamps (True) or original timestamps (False).

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "*/*", **(extra_headers or {})}
        response = await self._post(
            "/tts/sse",
            body=await async_maybe_transform(
                {
                    "model_id": model_id,
                    "output_format": output_format,
                    "transcript": transcript,
                    "voice": voice,
                    "add_phoneme_timestamps": add_phoneme_timestamps,
                    "add_timestamps": add_timestamps,
                    "context_id": context_id,
                    "generation_config": generation_config,
                    "language": language,
                    "pronunciation_dict_id": pronunciation_dict_id,
                    "speed": speed,
                    "use_normalized_timestamps": use_normalized_timestamps,
                },
                tts_generate_sse_params.TTSGenerateSseParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=httpx.Response,
        )
        return AsyncSSEEventStream(response=response, client=self._client)

    @deprecated("Use .generate_sse() instead")
    async def sse(
        self,
        *,
        model_id: str,
        output_format: tts_generate_sse_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        add_phoneme_timestamps: Optional[bool] | Omit = omit,
        add_timestamps: Optional[bool] | Omit = omit,
        context_id: Optional[str] | Omit = omit,
        generation_config: GenerationConfigParam | Omit = omit,
        language: SupportedLanguage | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        use_normalized_timestamps: Optional[bool] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncSSEEventStream:
        """
        Text to Speech (SSE) - Backward compatibility wrapper for generate_sse().
        """
        return await self.generate_sse(
            model_id=model_id,
            output_format=output_format,
            transcript=transcript,
            voice=voice,
            add_phoneme_timestamps=add_phoneme_timestamps,
            add_timestamps=add_timestamps,
            context_id=context_id,
            generation_config=generation_config,
            language=language,
            pronunciation_dict_id=pronunciation_dict_id,
            speed=speed,
            use_normalized_timestamps=use_normalized_timestamps,
            extra_headers=extra_headers,
            extra_query=extra_query,
            extra_body=extra_body,
            timeout=timeout,
        )

    @deprecated("Use .websocket_connect() instead")
    async def websocket(
        self,
        extra_query: Query = {},
        extra_headers: Headers = {},
        websocket_connection_options: WebsocketConnectionOptions = {},
    ) -> AsyncBackcompatTTSResourceConnection:
        """Create a WebSocket connection for real-time TTS streaming (v2 compatible)."""
        manager = self.websocket_connect(
            extra_query=extra_query,
            extra_headers=extra_headers,
            websocket_connection_options=websocket_connection_options,
        )
        return AsyncBackcompatTTSResourceConnection(manager)

    @deprecated("Use .generate() instead")
    async def bytes(
        self,
        *,
        model_id: str,
        output_format: tts_generate_params.OutputFormat,
        transcript: str,
        voice: VoiceSpecifierParam,
        duration: Optional[float] | Omit = omit,  # noqa: ARG002
        generation_config: GenerationConfigParam | Omit = omit,
        language: Optional[SupportedLanguage] | Omit = omit,
        pronunciation_dict_id: Optional[str] | Omit = omit,
        save: Optional[bool] | Omit = omit,
        speed: ModelSpeed | Omit = omit,
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncIterator[bytes]:
        """Text to Speech returning an async iterator of audio bytes.

        This is a convenience wrapper around generate() that returns an iterator
        directly, allowing you to iterate over chunks without calling .iter_bytes().
        """
        response = await self.generate(
            model_id=model_id,
            output_format=output_format,
            transcript=transcript,
            voice=voice,
            generation_config=generation_config,
            language=language,
            pronunciation_dict_id=pronunciation_dict_id,
            save=save,
            speed=speed,
            extra_headers=extra_headers,
            extra_query=extra_query,
            extra_body=extra_body,
            timeout=timeout,
        )
        return response.iter_bytes()

    async def infill(
        self,
        *,
        language: str | Omit = omit,
        left_audio: FileTypes | Omit = omit,
        model_id: str | Omit = omit,
        output_format: tts_infill_params.OutputFormat | Omit = omit,
        right_audio: FileTypes | Omit = omit,
        transcript: str | Omit = omit,
        voice_id: str | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncBinaryAPIResponse:
        """Generate audio that smoothly connects two existing audio segments.

        This is
        useful for inserting new speech between existing speech segments while
        maintaining natural transitions.

        **The cost is 1 credit per character of the infill text plus a fixed cost of 300
        credits.**

        At least one of `left_audio` or `right_audio` must be provided.

        As with all generative models, there's some inherent variability, but here's
        some tips we recommend to get the best results from infill:

        - Use longer infill transcripts
          - This gives the model more flexibility to adapt to the rest of the audio
        - Target natural pauses in the audio when deciding where to clip
          - This means you don't need word-level timestamps to be as precise
        - Clip right up to the start and end of the audio segment you want infilled,
          keeping as much silence in the left/right audio segments as possible
          - This helps the model generate more natural transitions

        Args:
          language: The language of the transcript

          model_id: The ID of the model to use for generating audio. Any model other than the first
              `"sonic"` model is supported.

          transcript: The infill text to generate

          voice_id: The ID of the voice to use for generating audio

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {"Accept": "audio/wav", **(extra_headers or {})}
        body = deepcopy_minimal(
            {
                "language": language,
                "left_audio": left_audio,
                "model_id": model_id,
                "output_format": output_format,
                "right_audio": right_audio,
                "transcript": transcript,
                "voice_id": voice_id,
            }
        )
        files = extract_files(cast(Mapping[str, object], body), paths=[["left_audio"], ["right_audio"]])
        # It should be noted that the actual Content-Type header that will be
        # sent to the server will contain a `boundary` parameter, e.g.
        # multipart/form-data; boundary=---abc--
        extra_headers = {"Content-Type": "multipart/form-data", **(extra_headers or {})}
        return await self._post(
            "/infill/bytes",
            body=await async_maybe_transform(body, tts_infill_params.TTSInfillParams),
            files=files,
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=AsyncBinaryAPIResponse,
        )

    def websocket_connect(
        self,
        extra_query: Query = {},
        extra_headers: Headers = {},
        websocket_connection_options: WebsocketConnectionOptions = {},
    ) -> AsyncTTSResourceConnectionManager:
        return AsyncTTSResourceConnectionManager(
            client=self._client,
            extra_query=extra_query,
            extra_headers=extra_headers,
            websocket_connection_options=websocket_connection_options,
        )


class TTSResourceWithRawResponse:
    def __init__(self, tts: TTSResource) -> None:
        self._tts = tts

        self.generate = to_custom_raw_response_wrapper(
            tts.generate,
            BinaryAPIResponse,
        )
        self.generate_sse = to_raw_response_wrapper(
            tts.generate_sse,
        )
        self.sse = self.generate_sse
        self.infill = to_custom_raw_response_wrapper(
            tts.infill,
            BinaryAPIResponse,
        )


class AsyncTTSResourceWithRawResponse:
    def __init__(self, tts: AsyncTTSResource) -> None:
        self._tts = tts

        self.generate = async_to_custom_raw_response_wrapper(
            tts.generate,
            AsyncBinaryAPIResponse,
        )
        self.generate_sse = async_to_raw_response_wrapper(
            tts.generate_sse,
        )
        self.sse = self.generate_sse
        self.infill = async_to_custom_raw_response_wrapper(
            tts.infill,
            AsyncBinaryAPIResponse,
        )


class TTSResourceWithStreamingResponse:
    def __init__(self, tts: TTSResource) -> None:
        self._tts = tts

        self.generate = to_custom_streamed_response_wrapper(
            tts.generate,
            StreamedBinaryAPIResponse,
        )
        self.generate_sse = to_streamed_response_wrapper(
            tts.generate_sse,
        )
        self.sse = self.generate_sse
        self.infill = to_custom_streamed_response_wrapper(
            tts.infill,
            StreamedBinaryAPIResponse,
        )


class AsyncTTSResourceWithStreamingResponse:
    def __init__(self, tts: AsyncTTSResource) -> None:
        self._tts = tts

        self.generate = async_to_custom_streamed_response_wrapper(
            tts.generate,
            AsyncStreamedBinaryAPIResponse,
        )
        self.generate_sse = async_to_streamed_response_wrapper(
            tts.generate_sse,
        )
        self.sse = self.generate_sse
        self.infill = async_to_custom_streamed_response_wrapper(
            tts.infill,
            AsyncStreamedBinaryAPIResponse,
        )


class AsyncTTSResourceConnection:
    """Represents a live WebSocket connection to the TTS API"""

    _connection: AsyncWebsocketConnection

    def __init__(self, connection: AsyncWebsocketConnection, manager: AsyncTTSResourceConnectionManager | None = None) -> None:
        self._connection = connection
        self._manager = manager
        self._context_queues: dict[str, asyncio.Queue[WebsocketResponse]] = {}
        self._processing_task: asyncio.Task[None] | None = None
        self._closing = False

    async def __aiter__(self) -> AsyncIterator[WebsocketResponse]:
        """
        An infinite-iterator that will continue to yield events until
        the connection is closed.
        """
        from websockets.exceptions import ConnectionClosedOK

        try:
            while True:
                yield await self.recv()
        except ConnectionClosedOK:
            return

    async def recv(self) -> WebsocketResponse:
        """
        Receive the next message from the connection and parses it into a `WebsocketResponse` object.

        Canceling this method is safe. There's no risk of losing data.
        """
        return self.parse_event(await self.recv_bytes())

    async def recv_bytes(self, timeout: float | None = None) -> bytes:
        """Receive the next message from the connection as raw bytes.

        Canceling this method is safe. There's no risk of losing data.

        If you want to parse the message into a `WebsocketResponse` object like `.recv()` does,
        then you can call `.parse_event(data)`.
        """
        if timeout is not None:
            import asyncio as _asyncio
            message = await _asyncio.wait_for(self._connection.recv(decode=False), timeout=timeout)
        else:
            message = await self._connection.recv(decode=False)
        log.debug(f"Received websocket message: %s", message)
        return message

    async def send(self, event: WebsocketClientEvent | WebsocketClientEventParam) -> None:
        await self._ensure_connected()
        data = (
            event.to_json(use_api_names=True, exclude_defaults=True, exclude_unset=True)
            if isinstance(event, BaseModel)
            else json.dumps(await async_maybe_transform(event, WebsocketClientEventParam))
        )
        await self._connection.send(data)

    async def close(self, *, code: int = 1000, reason: str = "") -> None:
        import asyncio as _asyncio

        self._closing = True
        try:
            if self._processing_task is not None:
                self._processing_task.cancel()
                try:
                    await self._processing_task
                except _asyncio.CancelledError:
                    pass
                self._processing_task = None
            await self._connection.close(code=code, reason=reason)
        finally:
            self._closing = False

    def _dispatch_listener(self) -> None:
        import asyncio as _asyncio

        if self._processing_task is None or self._processing_task.done():
            self._processing_task = _asyncio.create_task(self._process_responses())

    async def _process_responses(self) -> None:
        from websockets.exceptions import ConnectionClosed

        try:
            while True:
                raw = await self._connection.recv(decode=False)
                log.debug("Received websocket message: %s", raw)
                event = self.parse_event(raw)
                event_ctx = event.context_id if hasattr(event, "context_id") else None
                if event_ctx is not None and event_ctx in self._context_queues:
                    await self._context_queues[event_ctx].put(event)
                else:
                    log.debug("Received event for unregistered context %s", event_ctx)
        except ConnectionClosed:
            if not self._closing:
                log.warning("WebSocket connection closed unexpectedly")

    async def _ensure_connected(self) -> None:
        import asyncio as _asyncio

        from websockets.protocol import State

        if self._manager is not None and self._connection.state in (State.CLOSED, State.CLOSING):
            log.debug("Connection is not open (state=%s), reconnecting...", self._connection.state)
            if self._processing_task is not None:
                self._processing_task.cancel()
                try:
                    await self._processing_task
                except _asyncio.CancelledError:
                    pass
                self._processing_task = None
            new_conn = await self._manager.__aenter__()
            self._connection = new_conn._connection
            self._context_queues.clear()

    def parse_event(self, data: str | bytes) -> WebsocketResponse:
        """
        Converts a raw `str` or `bytes` message into a `WebsocketResponse` object.

        This is helpful if you're using `.recv_bytes()`.
        """
        return cast(
            WebsocketResponse, construct_type_unchecked(value=json.loads(data), type_=cast(Any, WebsocketResponse))
        )

    def context(
        self,
        context_id: Optional[str] = None,
        *,
        timeout: float | None = None,
        model_id: str | None = None,
        voice: VoiceSpecifierParam | None = None,
        output_format: Dict[str, Any] | None = None,
        language: SupportedLanguage | None = None,
        add_timestamps: bool | None = None,
        add_phoneme_timestamps: bool | None = None,
        generation_config: GenerationConfigParam | None = None,
    ) -> AsyncWebSocketContext:
        """Create a context helper for managing conversational flows.

        Args:
            context_id: Unique identifier for this context. If not provided,
                a UUID will be auto-generated.
            model_id: Default model_id for push().
            voice: Default voice for push().
            output_format: Default output_format for push().
            language: Default language for push().
            add_timestamps: Default add_timestamps for push().
            add_phoneme_timestamps: Default add_phoneme_timestamps for push().
            generation_config: Default generation_config for push().

        Returns:
            AsyncWebSocketContext helper for simplified sending and receiving
        """
        if context_id is not None and context_id in self._context_queues:
            raise ValueError(f"Context for context ID {context_id} already exists.")
        if context_id is None:
            context_id = str(uuid.uuid4())
        import asyncio
        self._context_queues[context_id] = asyncio.Queue()
        return AsyncWebSocketContext(
            self,
            context_id,
            timeout=timeout,
            model_id=model_id,
            voice=voice,
            output_format=output_format,
            language=language,
            add_timestamps=add_timestamps,
            add_phoneme_timestamps=add_phoneme_timestamps,
            generation_config=generation_config,
        )


class AsyncTTSResourceConnectionManager:
    """
    Context manager over a `AsyncTTSResourceConnection` that is returned by `tts.websocket_connect()`

    This context manager ensures that the connection will be closed when it exits.

    ---

    Note that if your application doesn't work well with the context manager approach then you
    can call the `.enter()` method directly to initiate a connection.

    **Warning**: You must remember to close the connection with `.close()`.

    ```py
    connection = await client.tts.websocket_connect(...).enter()
    # ...
    await connection.close()
    ```
    """

    def __init__(
        self,
        *,
        client: AsyncCartesia,
        extra_query: Query,
        extra_headers: Headers,
        websocket_connection_options: WebsocketConnectionOptions,
    ) -> None:
        self.__client = client
        self.__connection: AsyncTTSResourceConnection | None = None
        self.__extra_query = extra_query
        self.__extra_headers = extra_headers
        self.__websocket_connection_options = websocket_connection_options

    async def __aenter__(self) -> AsyncTTSResourceConnection:
        """
        👋 If your application doesn't work well with the context manager approach then you
        can call this method directly to initiate a connection.

        **Warning**: You must remember to close the connection with `.close()`.

        ```py
        connection = await client.tts.websocket_connect(...).enter()
        # ...
        await connection.close()
        ```
        """
        try:
            from websockets.asyncio.client import connect
        except ImportError as exc:
            raise CartesiaError("You need to install `cartesia[websockets]` to use this method") from exc

        url = self._prepare_url().copy_with(
            params={
                **self.__client.base_url.params,
                **self.__extra_query,
            },
        )
        log.debug("Connecting to %s", url)
        if self.__websocket_connection_options:
            log.debug("Connection options: %s", self.__websocket_connection_options)

        self.__connection = AsyncTTSResourceConnection(
            await connect(
                str(url),
                user_agent_header=self.__client.user_agent,
                additional_headers=_merge_mappings(
                    {
                        **self.__client.auth_headers,
                        "Cartesia-Version": self.__client.default_headers.get("cartesia-version", "2025-11-04"),
                    },
                    self.__extra_headers,
                ),
                **self.__websocket_connection_options,
            ),
            manager=self,
        )

        return self.__connection

    enter = __aenter__

    def _prepare_url(self) -> httpx.URL:
        if self.__client.websocket_base_url is not None:
            base_url = httpx.URL(self.__client.websocket_base_url)
        else:
            base_url = self.__client._base_url.copy_with(scheme="wss")

        merge_raw_path = base_url.raw_path.rstrip(b"/") + b"/tts/websocket"
        return base_url.copy_with(raw_path=merge_raw_path)

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, exc_tb: TracebackType | None
    ) -> None:
        if self.__connection is not None:
            await self.__connection.close()


class TTSResourceConnection:
    """Represents a live WebSocket connection to the TTS API"""

    _connection: WebsocketConnection

    def __init__(self, connection: WebsocketConnection, manager: TTSResourceConnectionManager | None = None) -> None:
        self._connection = connection
        self._manager = manager
        self._context_queues: dict[str, queue.Queue[WebsocketResponse]] = {}

    def __iter__(self) -> Iterator[WebsocketResponse]:
        """
        An infinite-iterator that will continue to yield events until
        the connection is closed.
        """
        from websockets.exceptions import ConnectionClosedOK

        try:
            while True:
                yield self.recv()
        except ConnectionClosedOK:
            return

    def recv(self) -> WebsocketResponse:
        """
        Receive the next message from the connection and parses it into a `WebsocketResponse` object.

        Canceling this method is safe. There's no risk of losing data.
        """
        return self.parse_event(self.recv_bytes())

    def recv_bytes(self, timeout: float | None = None) -> bytes:
        """Receive the next message from the connection as raw bytes.

        Canceling this method is safe. There's no risk of losing data.

        If you want to parse the message into a `WebsocketResponse` object like `.recv()` does,
        then you can call `.parse_event(data)`.
        """
        message = self._connection.recv(decode=False, timeout=timeout)
        log.debug(f"Received websocket message: %s", message)
        return message

    def send(self, event: WebsocketClientEvent | WebsocketClientEventParam) -> None:
        self._ensure_connected()
        data = (
            event.to_json(use_api_names=True, exclude_defaults=True, exclude_unset=True)
            if isinstance(event, BaseModel)
            else json.dumps(maybe_transform(event, WebsocketClientEventParam))
        )
        self._connection.send(data)

    def close(self, *, code: int = 1000, reason: str = "") -> None:
        self._connection.close(code=code, reason=reason)

    def _ensure_connected(self) -> None:
        from websockets.protocol import State

        if self._manager is not None and self._connection.state in (State.CLOSED, State.CLOSING):
            log.debug("Connection is not open (state=%s), reconnecting...", self._connection.state)
            new_conn = self._manager.__enter__()
            self._connection = new_conn._connection
            self._context_queues.clear()

    def parse_event(self, data: str | bytes) -> WebsocketResponse:
        """
        Converts a raw `str` or `bytes` message into a `WebsocketResponse` object.

        This is helpful if you're using `.recv_bytes()`.
        """
        return cast(
            WebsocketResponse, construct_type_unchecked(value=json.loads(data), type_=cast(Any, WebsocketResponse))
        )

    def context(
        self,
        context_id: Optional[str] = None,
        *,
        timeout: float | None = None,
        model_id: str | None = None,
        voice: VoiceSpecifierParam | None = None,
        output_format: Dict[str, Any] | None = None,
        language: SupportedLanguage | None = None,
        add_timestamps: bool | None = None,
        add_phoneme_timestamps: bool | None = None,
        generation_config: GenerationConfigParam | None = None,
    ) -> WebSocketContext:
        """Create a context helper for managing conversational flows.

        Args:
            context_id: Unique identifier for this context. If not provided,
                a UUID will be auto-generated.
            model_id: Default model_id for push().
            voice: Default voice for push().
            output_format: Default output_format for push().
            language: Default language for push().
            add_timestamps: Default add_timestamps for push().
            add_phoneme_timestamps: Default add_phoneme_timestamps for push().
            generation_config: Default generation_config for push().

        Returns:
            WebSocketContext helper for simplified sending and receiving
        """
        if context_id is not None and context_id in self._context_queues:
            raise ValueError(f"Context for context ID {context_id} already exists.")
        if context_id is None:
            context_id = str(uuid.uuid4())
        self._context_queues[context_id] = queue.Queue()
        return WebSocketContext(
            self,
            context_id,
            timeout=timeout,
            model_id=model_id,
            voice=voice,
            output_format=output_format,
            language=language,
            add_timestamps=add_timestamps,
            add_phoneme_timestamps=add_phoneme_timestamps,
            generation_config=generation_config,
        )


class TTSResourceConnectionManager:
    """
    Context manager over a `TTSResourceConnection` that is returned by `tts.websocket_connect()`

    This context manager ensures that the connection will be closed when it exits.

    ---

    Note that if your application doesn't work well with the context manager approach then you
    can call the `.enter()` method directly to initiate a connection.

    **Warning**: You must remember to close the connection with `.close()`.

    ```py
    connection = client.tts.websocket_connect(...).enter()
    # ...
    connection.close()
    ```
    """

    def __init__(
        self,
        *,
        client: Cartesia,
        extra_query: Query,
        extra_headers: Headers,
        websocket_connection_options: WebsocketConnectionOptions,
    ) -> None:
        self.__client = client
        self.__connection: TTSResourceConnection | None = None
        self.__extra_query = extra_query
        self.__extra_headers = extra_headers
        self.__websocket_connection_options = websocket_connection_options

    def __enter__(self) -> TTSResourceConnection:
        """
        👋 If your application doesn't work well with the context manager approach then you
        can call this method directly to initiate a connection.

        **Warning**: You must remember to close the connection with `.close()`.

        ```py
        connection = client.tts.websocket_connect(...).enter()
        # ...
        connection.close()
        ```
        """
        try:
            from websockets.sync.client import connect
        except ImportError as exc:
            raise CartesiaError("You need to install `cartesia[websockets]` to use this method") from exc

        url = self._prepare_url().copy_with(
            params={
                **self.__client.base_url.params,
                **self.__extra_query,
            },
        )
        log.debug("Connecting to %s", url)
        if self.__websocket_connection_options:
            log.debug("Connection options: %s", self.__websocket_connection_options)

        self.__connection = TTSResourceConnection(
            connect(
                str(url),
                user_agent_header=self.__client.user_agent,
                additional_headers=_merge_mappings(
                    {
                        **self.__client.auth_headers,
                        "Cartesia-Version": self.__client.default_headers.get("cartesia-version", "2025-11-04"),
                    },
                    self.__extra_headers,
                ),
                **self.__websocket_connection_options,
            ),
            manager=self,
        )

        return self.__connection

    enter = __enter__

    def _prepare_url(self) -> httpx.URL:
        if self.__client.websocket_base_url is not None:
            base_url = httpx.URL(self.__client.websocket_base_url)
        else:
            base_url = self.__client._base_url.copy_with(scheme="wss")

        merge_raw_path = base_url.raw_path.rstrip(b"/") + b"/tts/websocket"
        return base_url.copy_with(raw_path=merge_raw_path)

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, exc_tb: TracebackType | None
    ) -> None:
        if self.__connection is not None:
            self.__connection.close()

# WebSocket context helpers for managing conversational flows.
class WebSocketContext:
    """Context helper for managing WebSocket conversations with automatic context_id handling."""

    def __init__(
        self,
        connection: 'TTSResourceConnection',
        context_id: str,
        *,
        timeout: float | None = None,
        model_id: str | None = None,
        voice: VoiceSpecifierParam | None = None,
        output_format: Dict[str, Any] | None = None,
        language: SupportedLanguage | None = None,
        add_timestamps: bool | None = None,
        add_phoneme_timestamps: bool | None = None,
        generation_config: GenerationConfigParam | None = None,
    ):
        self._connection = connection
        self._context_id = context_id
        self._completed = False
        self._timeout = timeout
        self._model_id = model_id
        self._voice = voice
        self._output_format = output_format
        self._language = language
        self._add_timestamps = add_timestamps
        self._add_phoneme_timestamps = add_phoneme_timestamps
        self._generation_config = generation_config

    def send(
        self,
        *,
        model_id: str,
        transcript: str,
        voice: VoiceSpecifierParam,
        output_format: Optional[Dict[str, Any]] = None,
        continue_: bool = True,
        duration: Optional[float] | Omit = omit,
        language: Optional[SupportedLanguage] | Omit = omit,
        speed: Optional[ModelSpeed] | Omit = omit,
        add_timestamps: Optional[bool] | Omit = omit,
        add_phoneme_timestamps: Optional[bool] | Omit = omit,
        flush: Optional[bool] | Omit = omit,
        generation_config: Optional[GenerationConfigParam] | Omit = omit,
        **kwargs: Any,
    ) -> None:
        """Send a generation request with automatic context_id management."""
        if self._completed:
            raise ValueError("Cannot send to completed context. Call no_more_inputs() only once per context.")

        # Default output format
        if output_format is None:
            output_format = {
                "container": "raw",
                "encoding": "pcm_f32le",
                "sample_rate": 44100,
            }

        # Build request parameters, excluding omitted values
        request_params: dict[str, Any] = {
            "model_id": model_id,
            "transcript": transcript,
            "voice": voice,
            "output_format": output_format,
            "context_id": self._context_id,
            "continue": continue_,
        }

        # Add optional parameters only if they're not omitted
        if not isinstance(duration, Omit):
            request_params["duration"] = duration
        if not isinstance(language, Omit):
            request_params["language"] = language
        if not isinstance(speed, Omit):
            request_params["speed"] = speed
        if not isinstance(add_timestamps, Omit):
            request_params["add_timestamps"] = add_timestamps
        if not isinstance(add_phoneme_timestamps, Omit):
            request_params["add_phoneme_timestamps"] = add_phoneme_timestamps
        if not isinstance(flush, Omit):
            request_params["flush"] = flush
        if not isinstance(generation_config, Omit):
            request_params["generation_config"] = generation_config

        # Add any additional kwargs
        request_params.update(kwargs)

        request = GenerationRequest(**request_params)
        self._connection.send(request)

    def push(
        self,
        transcript: str,
        *,
        flush: Optional[bool] | Omit = omit,
        **kwargs: Any,
    ) -> None:
        """Send a generation request with continue_=True using context defaults."""
        if self._model_id is None or self._voice is None:
            raise ValueError("Context was initialized without required parameters (model_id, voice). Cannot use push().")

        language: SupportedLanguage | Omit = cast(SupportedLanguage, self._language) if self._language is not None else omit
        add_timestamps: bool | Omit = self._add_timestamps if self._add_timestamps is not None else omit
        add_phoneme_timestamps: bool | Omit = self._add_phoneme_timestamps if self._add_phoneme_timestamps is not None else omit

        # Use passed generation_config if provided in kwargs, otherwise use context default
        generation_config: GenerationConfigParam | None = kwargs.pop("generation_config", self._generation_config)

        self.send(
            model_id=self._model_id,
            transcript=transcript,
            voice=self._voice,
            output_format=self._output_format,
            continue_=True,
            language=language,
            add_timestamps=add_timestamps,
            add_phoneme_timestamps=add_phoneme_timestamps,
            flush=flush,
            generation_config=generation_config,
            **kwargs,
        )

    def no_more_inputs(self) -> None:
        """Signal that no more inputs will be sent for this context."""
        if self._completed:
            return  # Already completed, ignore

        model_id: str = self._model_id or "sonic-3"
        voice: VoiceSpecifierParam = self._voice or cast(VoiceSpecifierParam, {"mode": "id", "id": "6ccbfb76-1fc6-48f7-b71d-91ac6298247b"})
        output_format = self._output_format or {
            "container": "raw",
            "encoding": "pcm_f32le",
            "sample_rate": 44100,
        }
        language: SupportedLanguage | Omit = cast(SupportedLanguage, self._language) if self._language is not None else omit

        self.send(
            model_id=model_id,
            transcript="",
            voice=voice,
            output_format=output_format,
            continue_=False,
            language=language,
            generation_config=self._generation_config,
        )
        self._completed = True

    def cancel(self) -> None:
        """Cancel this context, stopping any in-progress generation."""
        self._connection.send(CancelContextRequest(cancel=True, context_id=self._context_id))
        self._connection._context_queues.pop(self._context_id, None)

    def receive(self) -> Iterator[WebsocketResponse]:
        """Receive responses filtered to this context only.

        When multiple contexts share a connection, the context that reads from
        the websocket acts as a router: non-matching events are placed onto the
        correct context's queue so they are never lost.
        """
        from websockets.exceptions import ConnectionClosedOK

        my_queue = self._connection._context_queues.get(self._context_id)
        done = False

        try:
            while True:
                # 1. Drain our own queue first (events routed here by another context).
                if my_queue is not None:
                    try:
                        event = my_queue.get_nowait()
                        yield event
                        if event.type in ("done", "error"):
                            done = True
                            return
                        continue
                    except queue.Empty:
                        pass

                # 2. Read the next event from the connection.
                try:
                    raw = self._connection.recv_bytes(timeout=self._timeout)
                    event = self._connection.parse_event(raw)
                except ConnectionClosedOK:
                    done = True
                    return
                except TimeoutError:
                    done = True
                    raise

                # 3. Route the event.
                event_ctx = event.context_id if hasattr(event, "context_id") else None

                if event_ctx == self._context_id:
                    yield event
                    if event.type in ("done", "error"):
                        done = True
                        return
                elif event_ctx is not None and event_ctx in self._connection._context_queues:
                    self._connection._context_queues[event_ctx].put(event)
                elif not hasattr(event, "context_id") and event.type in ("done", "error"):
                    # Global events without context_id
                    yield event
                    if event.type in ("done", "error"):
                        done = True
                        return
                else:
                    # Unregistered context — yield for backwards compat
                    yield event
                    if event.type == "done":
                        done = True
                        return
        finally:
            # Only unregister the queue if the context completed.  If the
            # consumer exited early (break / cancel), keep the queue so
            # future events for this context_id are absorbed rather than
            # leaking into other contexts via the fallback path.
            if done:
                self._connection._context_queues.pop(self._context_id, None)


class AsyncWebSocketContext:
    """Async context helper for managing WebSocket conversations with automatic context_id handling."""

    def __init__(
        self,
        connection: 'AsyncTTSResourceConnection',
        context_id: str,
        *,
        timeout: float | None = None,
        model_id: str | None = None,
        voice: VoiceSpecifierParam | None = None,
        output_format: Dict[str, Any] | None = None,
        language: SupportedLanguage | None = None,
        add_timestamps: bool | None = None,
        add_phoneme_timestamps: bool | None = None,
        generation_config: GenerationConfigParam | None = None,
    ):
        self._connection = connection
        self._context_id = context_id
        self._completed = False
        self._timeout = timeout
        self._model_id = model_id
        self._voice = voice
        self._output_format = output_format
        self._language = language
        self._add_timestamps = add_timestamps
        self._add_phoneme_timestamps = add_phoneme_timestamps
        self._generation_config = generation_config

    async def send(
        self,
        *,
        model_id: str,
        transcript: str,
        voice: VoiceSpecifierParam,
        output_format: Optional[Dict[str, Any]] = None,
        continue_: bool = True,
        duration: Optional[float] | Omit = omit,
        language: Optional[SupportedLanguage] | Omit = omit,
        speed: Optional[ModelSpeed] | Omit = omit,
        add_timestamps: Optional[bool] | Omit = omit,
        add_phoneme_timestamps: Optional[bool] | Omit = omit,
        flush: Optional[bool] | Omit = omit,
        generation_config: Optional[GenerationConfigParam] | Omit = omit,
        **kwargs: Any,
    ) -> None:
        """Send a generation request with automatic context_id management."""
        if self._completed:
            raise ValueError("Cannot send to completed context. Call no_more_inputs() only once per context.")

        # Default output format
        if output_format is None:
            output_format = {
                "container": "raw",
                "encoding": "pcm_f32le",
                "sample_rate": 44100,
            }

        # Build request parameters, excluding omitted values
        request_params: dict[str, Any] = {
            "model_id": model_id,
            "transcript": transcript,
            "voice": voice,
            "output_format": output_format,
            "context_id": self._context_id,
            "continue": continue_,
        }

        # Add optional parameters only if they're not omitted
        if not isinstance(duration, Omit):
            request_params["duration"] = duration
        if not isinstance(language, Omit):
            request_params["language"] = language
        if not isinstance(speed, Omit):
            request_params["speed"] = speed
        if not isinstance(add_timestamps, Omit):
            request_params["add_timestamps"] = add_timestamps
        if not isinstance(add_phoneme_timestamps, Omit):
            request_params["add_phoneme_timestamps"] = add_phoneme_timestamps
        if not isinstance(flush, Omit):
            request_params["flush"] = flush
        if not isinstance(generation_config, Omit):
            request_params["generation_config"] = generation_config

        # Add any additional kwargs
        request_params.update(kwargs)

        request = GenerationRequest(**request_params)
        await self._connection.send(request)
        self._connection._dispatch_listener()

    async def push(
        self,
        transcript: str,
        *,
        flush: Optional[bool] | Omit = omit,
        **kwargs: Any,
    ) -> None:
        """Send a generation request with continue_=True using context defaults."""
        if self._model_id is None or self._voice is None:
            raise ValueError("Context was initialized without required parameters (model_id, voice). Cannot use push().")

        language: SupportedLanguage | Omit = cast(SupportedLanguage, self._language) if self._language is not None else omit
        add_timestamps: bool | Omit = self._add_timestamps if self._add_timestamps is not None else omit
        add_phoneme_timestamps: bool | Omit = self._add_phoneme_timestamps if self._add_phoneme_timestamps is not None else omit

        # Use passed generation_config if provided in kwargs, otherwise use context default
        generation_config: GenerationConfigParam | None = kwargs.pop("generation_config", self._generation_config)

        await self.send(
            model_id=self._model_id,
            transcript=transcript,
            voice=self._voice,
            output_format=self._output_format,
            continue_=True,
            language=language,
            add_timestamps=add_timestamps,
            add_phoneme_timestamps=add_phoneme_timestamps,
            flush=flush,
            generation_config=generation_config,
            **kwargs,
        )

    async def no_more_inputs(self) -> None:
        """Signal that no more inputs will be sent for this context."""
        if self._completed:
            return  # Already completed, ignore

        model_id: str = self._model_id or "sonic-3"
        voice: VoiceSpecifierParam = self._voice or cast(VoiceSpecifierParam, {"mode": "id", "id": "6ccbfb76-1fc6-48f7-b71d-91ac6298247b"})
        output_format = self._output_format or {
            "container": "raw",
            "encoding": "pcm_f32le",
            "sample_rate": 44100,
        }
        language: SupportedLanguage | Omit = cast(SupportedLanguage, self._language) if self._language is not None else omit

        await self.send(
            model_id=model_id,
            transcript="",
            voice=voice,
            output_format=output_format,
            continue_=False,
            language=language,
            generation_config=self._generation_config,
        )
        self._completed = True

    async def cancel(self) -> None:
        """Cancel this context, stopping any in-progress generation."""
        await self._connection.send(CancelContextRequest(cancel=True, context_id=self._context_id))
        self._connection._context_queues.pop(self._context_id, None)

    async def receive(self) -> AsyncIterator[WebsocketResponse]:
        """Receive responses filtered to this context only.

        A background task on the connection continuously reads from the wire
        and routes events into per-context queues.  This method simply drains
        the queue for this context.
        """
        import asyncio as _asyncio

        my_queue = self._connection._context_queues.get(self._context_id)
        if my_queue is None:
            return

        done = False

        try:
            while True:
                try:
                    if self._timeout is not None:
                        event = await _asyncio.wait_for(my_queue.get(), timeout=self._timeout)
                    else:
                        event = await my_queue.get()
                except TimeoutError:
                    done = True
                    raise

                yield event
                if event.type in ("done", "error"):
                    done = True
                    return
        finally:
            if done:
                self._connection._context_queues.pop(self._context_id, None)


class BackcompatWebSocketTtsOutput(BaseModel):
    """Output object for backward compatibility with v2 WebSocket response."""
    audio: Optional[bytes] = None
    word_timestamps: Optional[Any] = None
    phoneme_timestamps: Optional[Any] = None
    context_id: Optional[str] = None
    flush_done: Optional[bool] = None
    flush_id: Optional[str] = None


class BackcompatTTSResourceConnection:
    """Wrapper for TTSResourceConnection to provide v2-compatible API."""

    def __init__(self, manager: TTSResourceConnectionManager):
        self._manager = manager
        self._connection: Optional[TTSResourceConnection] = None

    def connect(self) -> None:
        if self._connection is None:
            self._connection = self._manager.enter()

    def close(self) -> None:
        if self._connection:
            self._manager.__exit__(None, None, None)
            self._connection = None

    def context(self, context_id: Optional[str] = None) -> WebSocketContext:
        """Create a context helper (v2 compatible)."""
        if not self._connection:
            self.connect()
        assert self._connection is not None
        return self._connection.context(context_id)

    def send(
        self,
        *,
        model_id: str,
        transcript: str,
        output_format: Dict[str, Any],
        voice: Dict[str, Any],
        context_id: Optional[str] = None,
        stream: bool = True,
        **kwargs: Any,
    ) -> "Iterator[BackcompatWebSocketTtsOutput] | BackcompatWebSocketTtsOutput":
        """Send a request and return responses (v2 compatible).

        If stream is True, returns an iterator of BackcompatWebSocketTtsOutput chunks.
        If stream is False, returns a single BackcompatWebSocketTtsOutput with all
        audio concatenated and timestamps aggregated (matching v2 behaviour).
        """
        if not self._connection:
            self.connect()
        assert self._connection is not None
        self._connection._ensure_connected()

        ctx = self._connection.context(context_id)

        # Send the request
        ctx.send(
            model_id=model_id,
            transcript=transcript,
            voice=cast(VoiceSpecifierParam, voice),
            output_format=output_format,
            continue_=False,
            **kwargs,
        )

        # Generate output stream
        def generator() -> Iterator[BackcompatWebSocketTtsOutput]:
            for event in ctx.receive():
                if event.type == "error":
                    raise RuntimeError(f"Error generating audio:\n{getattr(event, 'error', 'Unknown error')}")

                out = BackcompatWebSocketTtsOutput(
                    context_id=event.context_id
                )

                if event.type == "chunk":
                    out.audio = event.audio
                elif event.type == "timestamps":
                    out.word_timestamps = getattr(event, "word_timestamps", None)
                elif event.type == "phoneme_timestamps":
                    out.phoneme_timestamps = getattr(event, "phoneme_timestamps", None)
                elif event.type == "flush_done":
                    out.flush_done = getattr(event, "flush_done", None)
                    out.flush_id = getattr(event, "flush_id", None)

                yield out

        if stream:
            return generator()

        audio_parts: list[bytes] = []
        words: list[str] = []
        word_starts: list[float] = []
        word_ends: list[float] = []
        phonemes: list[str] = []
        phoneme_starts: list[float] = []
        phoneme_ends: list[float] = []
        for chunk in generator():
            if chunk.audio is not None:
                audio_parts.append(chunk.audio)
            if chunk.word_timestamps is not None:
                wt = chunk.word_timestamps
                words.extend(wt.words)
                word_starts.extend(wt.start)
                word_ends.extend(wt.end)
            if chunk.phoneme_timestamps is not None:
                pt = chunk.phoneme_timestamps
                phonemes.extend(pt.phonemes)
                phoneme_starts.extend(pt.start)
                phoneme_ends.extend(pt.end)
        return BackcompatWebSocketTtsOutput(
            audio=b"".join(audio_parts) if audio_parts else None,
            context_id=ctx._context_id,
            word_timestamps={"words": words, "start": word_starts, "end": word_ends} if words else None,
            phoneme_timestamps={"phonemes": phonemes, "start": phoneme_starts, "end": phoneme_ends} if phonemes else None,
        )


class AsyncBackcompatTTSResourceConnection:
    """Wrapper for AsyncTTSResourceConnection to provide v2-compatible API."""

    def __init__(self, manager: AsyncTTSResourceConnectionManager):
        self._manager = manager
        self._connection: Optional[AsyncTTSResourceConnection] = None

    async def connect(self) -> None:
        if self._connection is None:
            self._connection = await self._manager.enter()

    async def close(self) -> None:
        if self._connection:
            await self._manager.__aexit__(None, None, None)
            self._connection = None

    def context(self, context_id: Optional[str] = None) -> AsyncWebSocketContext:
        """Create a context helper (v2 compatible)."""
        if not self._connection:
            raise RuntimeError("Must call connect() before creating context")
        return self._connection.context(context_id)

    async def send(
        self,
        *,
        model_id: str,
        transcript: str,
        output_format: Dict[str, Any],
        voice: Dict[str, Any],
        context_id: Optional[str] = None,
        stream: bool = True,
        **kwargs: Any,
    ) -> "AsyncIterator[BackcompatWebSocketTtsOutput] | BackcompatWebSocketTtsOutput":
        """Send a request and return responses (v2 compatible).

        If stream is True, returns an async iterator of BackcompatWebSocketTtsOutput chunks.
        If stream is False, returns a single BackcompatWebSocketTtsOutput with all
        audio concatenated and timestamps aggregated (matching v2 behaviour).
        """
        if not self._connection:
            await self.connect()
        assert self._connection is not None
        await self._connection._ensure_connected()

        ctx = self._connection.context(context_id)

        # Send the request
        await ctx.send(
            model_id=model_id,
            transcript=transcript,
            voice=cast(VoiceSpecifierParam, voice),
            output_format=output_format,
            continue_=False,
            **kwargs,
        )

        # Generate output stream
        async def generator() -> AsyncIterator[BackcompatWebSocketTtsOutput]:
            async for event in ctx.receive():
                if event.type == "error":
                    raise RuntimeError(f"Error generating audio:\n{getattr(event, 'error', 'Unknown error')}")

                out = BackcompatWebSocketTtsOutput(
                    context_id=event.context_id
                )

                if event.type == "chunk":
                    out.audio = event.audio
                elif event.type == "timestamps":
                    out.word_timestamps = getattr(event, "word_timestamps", None)
                elif event.type == "phoneme_timestamps":
                    out.phoneme_timestamps = getattr(event, "phoneme_timestamps", None)
                elif event.type == "flush_done":
                    out.flush_done = getattr(event, "flush_done", None)
                    out.flush_id = getattr(event, "flush_id", None)

                yield out

        if stream:
            return generator()

        audio_parts: list[bytes] = []
        words: list[str] = []
        word_starts: list[float] = []
        word_ends: list[float] = []
        phonemes: list[str] = []
        phoneme_starts: list[float] = []
        phoneme_ends: list[float] = []
        async for chunk in generator():
            if chunk.audio is not None:
                audio_parts.append(chunk.audio)
            if chunk.word_timestamps is not None:
                wt = chunk.word_timestamps
                words.extend(wt.words)
                word_starts.extend(wt.start)
                word_ends.extend(wt.end)
            if chunk.phoneme_timestamps is not None:
                pt = chunk.phoneme_timestamps
                phonemes.extend(pt.phonemes)
                phoneme_starts.extend(pt.start)
                phoneme_ends.extend(pt.end)
        return BackcompatWebSocketTtsOutput(
            audio=b"".join(audio_parts) if audio_parts else None,
            context_id=ctx._context_id,
            word_timestamps={"words": words, "start": word_starts, "end": word_ends} if words else None,
            phoneme_timestamps={"phonemes": phonemes, "start": phoneme_starts, "end": phoneme_ends} if phonemes else None,
        )
