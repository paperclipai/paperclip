# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Optional
from typing_extensions import Literal

from pydantic import Field as FieldInfo

from .._models import BaseModel
from .model_speed import ModelSpeed
from .raw_encoding import RawEncoding
from .voice_specifier import VoiceSpecifier
from .generation_config import GenerationConfig
from .supported_language import SupportedLanguage

__all__ = ["GenerationRequest", "OutputFormat"]


class OutputFormat(BaseModel):
    container: Literal["raw"]

    encoding: RawEncoding

    sample_rate: Literal[8000, 16000, 22050, 24000, 44100, 48000]


class GenerationRequest(BaseModel):
    llm_model_id: str = FieldInfo(alias="model_id")
    """The ID of the model to use for the generation.

    See [Models](/build-with-cartesia/tts-models) for available models.
    """

    output_format: OutputFormat

    transcript: str
    """The transcript to generate speech for."""

    voice: VoiceSpecifier

    add_phoneme_timestamps: Optional[bool] = None
    """Whether to return phoneme-level timestamps.

    If `false` (default), no phoneme timestamps will be produced. If `true`, the
    server will return timestamp events containing phoneme-level timing information.
    """

    add_timestamps: Optional[bool] = None
    """Whether to return word-level timestamps.

    If `false` (default), no word timestamps will be produced at all. If `true`, the
    server will return timestamp events containing word-level timing information.
    """

    context_id: Optional[str] = None
    """A unique identifier for the context.

    You can use any unique identifier, like a UUID or human ID.

    Some customers use unique identifiers from their own systems (such as
    conversation IDs) as context IDs.
    """

    continue_: Optional[bool] = FieldInfo(alias="continue", default=None)
    """
    Whether this input may be followed by more inputs. If not specified, this
    defaults to `false`.
    """

    flush: Optional[bool] = None
    """Whether to flush the context."""

    generation_config: Optional[GenerationConfig] = None
    """Configure the various attributes of the generated speech.

    These are only for `sonic-3` and have no effect on earlier models.

    See
    [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion)
    for a guide on this option.
    """

    language: Optional[SupportedLanguage] = None
    """The language that the given voice should speak the transcript in.

    For valid options, see [Models](/build-with-cartesia/tts-models).
    """

    max_buffer_delay_ms: Optional[int] = None
    """The maximum time in milliseconds to buffer text before starting generation.

    Values between [0, 5000]ms are supported. Defaults to 3000ms.

    When set, the model will buffer incoming text chunks until it's confident it has
    enough context to generate high-quality speech, or the buffer delay elapses,
    whichever comes first. Without this option set, the model will kick off
    generations immediately, ceding control of buffering to the user.

    Use this to balance responsiveness with higher quality speech generation, which
    often benefits from having more context.
    """

    pronunciation_dict_id: Optional[str] = None
    """The ID of a pronunciation dictionary to use for the generation.

    Pronunciation dictionaries are supported by `sonic-3` models and newer.
    """

    speed: Optional[ModelSpeed] = None
    """Use `generation_config.speed` for sonic-3. Speed setting for the model.

    Defaults to `normal`. This feature is experimental and may not work for all
    voices. Influences the speed of the generated speech. Faster speeds may reduce
    hallucination rate.
    """

    use_normalized_timestamps: Optional[bool] = None
    """Whether to use normalized timestamps (True) or original timestamps (False)."""
