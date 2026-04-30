# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .beta_tool_param import BetaToolParam
from .beta_mcp_toolset_param import BetaMCPToolsetParam
from .beta_tool_bash_20241022_param import BetaToolBash20241022Param
from .beta_tool_bash_20250124_param import BetaToolBash20250124Param
from .beta_memory_tool_20250818_param import BetaMemoryTool20250818Param
from .beta_advisor_tool_20260301_param import BetaAdvisorTool20260301Param
from .beta_web_fetch_tool_20250910_param import BetaWebFetchTool20250910Param
from .beta_web_fetch_tool_20260209_param import BetaWebFetchTool20260209Param
from .beta_web_fetch_tool_20260309_param import BetaWebFetchTool20260309Param
from .beta_web_search_tool_20250305_param import BetaWebSearchTool20250305Param
from .beta_web_search_tool_20260209_param import BetaWebSearchTool20260209Param
from .beta_tool_text_editor_20241022_param import BetaToolTextEditor20241022Param
from .beta_tool_text_editor_20250124_param import BetaToolTextEditor20250124Param
from .beta_tool_text_editor_20250429_param import BetaToolTextEditor20250429Param
from .beta_tool_text_editor_20250728_param import BetaToolTextEditor20250728Param
from .beta_tool_computer_use_20241022_param import BetaToolComputerUse20241022Param
from .beta_tool_computer_use_20250124_param import BetaToolComputerUse20250124Param
from .beta_tool_computer_use_20251124_param import BetaToolComputerUse20251124Param
from .beta_code_execution_tool_20250522_param import BetaCodeExecutionTool20250522Param
from .beta_code_execution_tool_20250825_param import BetaCodeExecutionTool20250825Param
from .beta_code_execution_tool_20260120_param import BetaCodeExecutionTool20260120Param
from .beta_tool_search_tool_bm25_20251119_param import BetaToolSearchToolBm25_20251119Param
from .beta_tool_search_tool_regex_20251119_param import BetaToolSearchToolRegex20251119Param

__all__ = ["BetaToolUnionParam"]

BetaToolUnionParam: TypeAlias = Union[
    BetaToolParam,
    BetaToolBash20241022Param,
    BetaToolBash20250124Param,
    BetaCodeExecutionTool20250522Param,
    BetaCodeExecutionTool20250825Param,
    BetaCodeExecutionTool20260120Param,
    BetaToolComputerUse20241022Param,
    BetaMemoryTool20250818Param,
    BetaToolComputerUse20250124Param,
    BetaToolTextEditor20241022Param,
    BetaToolComputerUse20251124Param,
    BetaToolTextEditor20250124Param,
    BetaToolTextEditor20250429Param,
    BetaToolTextEditor20250728Param,
    BetaWebSearchTool20250305Param,
    BetaWebFetchTool20250910Param,
    BetaWebSearchTool20260209Param,
    BetaWebFetchTool20260209Param,
    BetaWebFetchTool20260309Param,
    BetaAdvisorTool20260301Param,
    BetaToolSearchToolBm25_20251119Param,
    BetaToolSearchToolRegex20251119Param,
    BetaMCPToolsetParam,
]
