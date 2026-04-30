# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, TypeAlias

__all__ = ["BetaManagedAgentsModel"]

BetaManagedAgentsModel: TypeAlias = Union[
    Literal[
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-5",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4-5",
        "claude-sonnet-4-5-20250929",
    ],
    str,
]
