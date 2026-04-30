# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Required, TypedDict

__all__ = ["MetricCreateParams"]


class MetricCreateParams(TypedDict, total=False):
    name: Required[str]
    """The name of the metric.

    This must be a unique name that only allows lower case letters, numbers, and the
    characters \\__, -, and .
    """

    prompt: Required[str]
    """
    The prompt associated with the metric, detailing the task and evaluation
    criteria.
    """

    display_name: Optional[str]
    """The display name of the metric."""
