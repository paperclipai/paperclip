# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

__all__ = ["BetaCodeExecutionOutputBlockParam"]


class BetaCodeExecutionOutputBlockParam(TypedDict, total=False):
    file_id: Required[str]

    type: Required[Literal["code_execution_output"]]
