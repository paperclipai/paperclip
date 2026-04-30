# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Required, TypedDict

__all__ = ["DatasetCreateParams"]


class DatasetCreateParams(TypedDict, total=False):
    description: Required[str]
    """Optional description for the dataset"""

    name: Required[str]
    """Name for the new dataset"""
