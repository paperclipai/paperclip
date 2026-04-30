# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaMemoryTool20250818RenameCommand"]


class BetaMemoryTool20250818RenameCommand(BaseModel):
    command: Literal["rename"]
    """Command type identifier"""

    new_path: str
    """New path for the file or directory"""

    old_path: str
    """Current path of the file or directory"""
