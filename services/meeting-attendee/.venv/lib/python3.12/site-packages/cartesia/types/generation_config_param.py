# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import Literal, TypedDict

__all__ = ["GenerationConfigParam"]


class GenerationConfigParam(TypedDict, total=False):
    """Configure the various attributes of the generated speech.

    These are only for `sonic-3` and have no effect on earlier models.

    See [Volume, Speed, and Emotion in Sonic-3](/build-with-cartesia/sonic-3/volume-speed-emotion) for a guide on this option.
    """

    emotion: Union[
        str,
        Literal[
            "neutral",
            "happy",
            "excited",
            "enthusiastic",
            "elated",
            "euphoric",
            "triumphant",
            "amazed",
            "surprised",
            "flirtatious",
            "curious",
            "content",
            "peaceful",
            "serene",
            "calm",
            "grateful",
            "affectionate",
            "trust",
            "sympathetic",
            "anticipation",
            "mysterious",
            "angry",
            "mad",
            "outraged",
            "frustrated",
            "agitated",
            "threatened",
            "disgusted",
            "contempt",
            "envious",
            "sarcastic",
            "ironic",
            "sad",
            "dejected",
            "melancholic",
            "disappointed",
            "hurt",
            "guilty",
            "bored",
            "tired",
            "rejected",
            "nostalgic",
            "wistful",
            "apologetic",
            "hesitant",
            "insecure",
            "confused",
            "resigned",
            "anxious",
            "panicked",
            "alarmed",
            "scared",
            "proud",
            "confident",
            "distant",
            "skeptical",
            "contemplative",
            "determined",
        ],
    ]
    """Guide the emotion of the generated speech."""

    speed: float
    """
    Adjust the speed of the generated speech between 0.6x and 1.5x the original
    speed (default is 1.0x). Valid values are between [0.6, 1.5] inclusive.
    """

    volume: float
    """
    Adjust the volume of the generated speech between 0.5x and 2.0x the original
    volume (default is 1.0x). Valid values are between [0.5, 2.0] inclusive.
    """
