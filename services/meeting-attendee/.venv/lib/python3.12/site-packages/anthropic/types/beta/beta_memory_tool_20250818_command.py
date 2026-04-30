# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ..._utils import PropertyInfo
from .beta_memory_tool_20250818_view_command import BetaMemoryTool20250818ViewCommand
from .beta_memory_tool_20250818_create_command import BetaMemoryTool20250818CreateCommand
from .beta_memory_tool_20250818_delete_command import BetaMemoryTool20250818DeleteCommand
from .beta_memory_tool_20250818_insert_command import BetaMemoryTool20250818InsertCommand
from .beta_memory_tool_20250818_rename_command import BetaMemoryTool20250818RenameCommand
from .beta_memory_tool_20250818_str_replace_command import BetaMemoryTool20250818StrReplaceCommand

__all__ = ["BetaMemoryTool20250818Command"]

BetaMemoryTool20250818Command: TypeAlias = Annotated[
    Union[
        BetaMemoryTool20250818ViewCommand,
        BetaMemoryTool20250818CreateCommand,
        BetaMemoryTool20250818StrReplaceCommand,
        BetaMemoryTool20250818InsertCommand,
        BetaMemoryTool20250818DeleteCommand,
        BetaMemoryTool20250818RenameCommand,
    ],
    PropertyInfo(discriminator="command"),
]
