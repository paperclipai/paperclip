# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .tool_param import ToolParam
from .tool_bash_20250124_param import ToolBash20250124Param
from .memory_tool_20250818_param import MemoryTool20250818Param
from .web_fetch_tool_20250910_param import WebFetchTool20250910Param
from .web_fetch_tool_20260209_param import WebFetchTool20260209Param
from .web_fetch_tool_20260309_param import WebFetchTool20260309Param
from .web_search_tool_20250305_param import WebSearchTool20250305Param
from .web_search_tool_20260209_param import WebSearchTool20260209Param
from .tool_text_editor_20250124_param import ToolTextEditor20250124Param
from .tool_text_editor_20250429_param import ToolTextEditor20250429Param
from .tool_text_editor_20250728_param import ToolTextEditor20250728Param
from .code_execution_tool_20250522_param import CodeExecutionTool20250522Param
from .code_execution_tool_20250825_param import CodeExecutionTool20250825Param
from .code_execution_tool_20260120_param import CodeExecutionTool20260120Param
from .tool_search_tool_bm25_20251119_param import ToolSearchToolBm25_20251119Param
from .tool_search_tool_regex_20251119_param import ToolSearchToolRegex20251119Param

__all__ = ["MessageCountTokensToolParam"]

MessageCountTokensToolParam: TypeAlias = Union[
    ToolParam,
    ToolBash20250124Param,
    CodeExecutionTool20250522Param,
    CodeExecutionTool20250825Param,
    CodeExecutionTool20260120Param,
    MemoryTool20250818Param,
    ToolTextEditor20250124Param,
    ToolTextEditor20250429Param,
    ToolTextEditor20250728Param,
    WebSearchTool20250305Param,
    WebFetchTool20250910Param,
    WebSearchTool20260209Param,
    WebFetchTool20260209Param,
    WebFetchTool20260309Param,
    ToolSearchToolBm25_20251119Param,
    ToolSearchToolRegex20251119Param,
]
