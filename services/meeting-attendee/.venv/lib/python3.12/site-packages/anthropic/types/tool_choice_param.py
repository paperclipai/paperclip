# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .tool_choice_any_param import ToolChoiceAnyParam
from .tool_choice_auto_param import ToolChoiceAutoParam
from .tool_choice_none_param import ToolChoiceNoneParam
from .tool_choice_tool_param import ToolChoiceToolParam

__all__ = ["ToolChoiceParam"]

ToolChoiceParam: TypeAlias = Union[ToolChoiceAutoParam, ToolChoiceAnyParam, ToolChoiceToolParam, ToolChoiceNoneParam]
