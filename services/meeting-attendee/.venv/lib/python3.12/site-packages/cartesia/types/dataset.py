# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from .._models import BaseModel

__all__ = ["Dataset"]


class Dataset(BaseModel):
    """A collection of files used for fine-tuning models"""

    id: str
    """Unique identifier for the dataset"""

    created_at: str
    """Timestamp when the dataset was created"""

    description: str
    """Optional description of the dataset"""

    name: str
    """Name of the dataset"""
