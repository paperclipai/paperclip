# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaMemoryTool20250818InsertCommand"]


class BetaMemoryTool20250818InsertCommand(BaseModel):
    command: Literal["insert"]
    """Command type identifier"""

    insert_line: int
    """Line number where text should be inserted"""

    insert_text: str
    """Text to insert at the specified line"""

    path: str
    """Path to the file where text should be inserted"""
