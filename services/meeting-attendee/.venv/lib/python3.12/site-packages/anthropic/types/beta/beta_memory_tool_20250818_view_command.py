# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import List, Optional
from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaMemoryTool20250818ViewCommand"]


class BetaMemoryTool20250818ViewCommand(BaseModel):
    command: Literal["view"]
    """Command type identifier"""

    path: str
    """Path to directory or file to view"""

    view_range: Optional[List[int]] = None
    """Optional line range for viewing specific lines"""
