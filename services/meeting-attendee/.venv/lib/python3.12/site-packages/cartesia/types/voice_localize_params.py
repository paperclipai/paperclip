# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

__all__ = ["VoiceLocalizeParams"]


class VoiceLocalizeParams(TypedDict, total=False):
    description: Required[str]
    """The description of the new localized voice."""

    language: Required[
        Literal["en", "de", "es", "fr", "ja", "pt", "zh", "hi", "it", "ko", "nl", "pl", "ru", "sv", "tr"]
    ]
    """Target language to localize the voice to.

    Options: English (en), German (de), Spanish (es), French (fr), Japanese (ja),
    Portuguese (pt), Chinese (zh), Hindi (hi), Italian (it), Korean (ko), Dutch
    (nl), Polish (pl), Russian (ru), Swedish (sv), Turkish (tr).
    """

    name: Required[str]
    """The name of the new localized voice."""

    original_speaker_gender: Required[Literal["male", "female"]]

    voice_id: Required[str]
    """The ID of the voice to localize."""

    dialect: Optional[Literal["au", "in", "so", "uk", "us", "mx", "pe", "br", "eu", "ca"]]
    """The dialect to localize to.

    Only supported for English (`en`), Spanish (`es`), Portuguese (`pt`), and French
    (`fr`).
    """
