# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["ServerToolCaller20260120Param"]


class ServerToolCaller20260120Param(TypedDict, total=False):
    tool_id: Required[str]

    type: Required[Literal["code_execution_20260120"]]
