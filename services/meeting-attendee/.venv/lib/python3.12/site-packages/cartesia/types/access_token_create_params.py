# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import TypedDict

__all__ = ["AccessTokenCreateParams", "Grants"]


class AccessTokenCreateParams(TypedDict, total=False):
    expires_in: Optional[int]
    """The number of seconds the token will be valid for since the time of generation.

    The maximum is 1 hour (3600 seconds).
    """

    grants: Optional[Grants]
    """The permissions to be granted via the token.

    Both TTS and STT grants are optional - specify only the capabilities you need.
    """


class Grants(TypedDict, total=False):
    """The permissions to be granted via the token.

    Both TTS and STT grants are optional - specify only the capabilities you need.
    """

    agent: Optional[bool]
    """
    The `agent` grant allows the token to be used to access the Agent websocket
    calling [endpoint](/line/integrations/web-calls#connection).
    """

    stt: Optional[bool]
    """The `stt` grant allows the token to be used to access any STT endpoint."""

    tts: Optional[bool]
    """The `tts` grant allows the token to be used to access any TTS endpoint."""
