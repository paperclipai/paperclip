# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from pydantic import Field as FieldInfo

from .._models import BaseModel

__all__ = ["FineTune"]


class FineTune(BaseModel):
    """Information about a fine-tune"""

    id: str
    """Unique identifier for the fine-tune"""

    dataset: str
    """ID of the dataset used for fine-tuning"""

    description: str
    """Description of the fine-tune"""

    language: str
    """Language code of the fine-tune"""

    llm_model_id: str = FieldInfo(alias="model_id")
    """Base model identifier to fine-tune from"""

    name: str
    """Name of the fine-tune"""

    status: Literal["created", "training", "completed", "failed"]
    """Current status of the fine-tune"""
