# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal, TypeAlias

__all__ = ["StopReason"]

StopReason: TypeAlias = Literal["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]
