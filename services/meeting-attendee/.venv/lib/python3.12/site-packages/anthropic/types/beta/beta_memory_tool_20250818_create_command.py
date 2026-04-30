# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaMemoryTool20250818CreateCommand"]


class BetaMemoryTool20250818CreateCommand(BaseModel):
    command: Literal["create"]
    """Command type identifier"""

    file_text: str
    """Content to write to the file"""

    path: str
    """Path where the file should be created"""
