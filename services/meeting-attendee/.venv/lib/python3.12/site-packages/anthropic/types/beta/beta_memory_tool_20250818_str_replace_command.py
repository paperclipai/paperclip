# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaMemoryTool20250818StrReplaceCommand"]


class BetaMemoryTool20250818StrReplaceCommand(BaseModel):
    command: Literal["str_replace"]
    """Command type identifier"""

    new_str: str
    """Text to replace with"""

    old_str: str
    """Text to search for and replace"""

    path: str
    """Path to the file where text should be replaced"""
