# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Required, TypedDict

__all__ = ["FineTuneCreateParams"]


class FineTuneCreateParams(TypedDict, total=False):
    dataset: Required[str]
    """Dataset ID containing training files"""

    description: Required[str]
    """Description for the fine-tune"""

    language: Required[str]
    """Language code for the fine-tune"""

    model_id: Required[str]
    """Base model ID to fine-tune from"""

    name: Required[str]
    """Name for the new fine-tune"""
