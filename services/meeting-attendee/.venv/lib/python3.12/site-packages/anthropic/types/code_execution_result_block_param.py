# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable
from typing_extensions import Literal, Required, TypedDict

from .code_execution_output_block_param import CodeExecutionOutputBlockParam

__all__ = ["CodeExecutionResultBlockParam"]


class CodeExecutionResultBlockParam(TypedDict, total=False):
    content: Required[Iterable[CodeExecutionOutputBlockParam]]

    return_code: Required[int]

    stderr: Required[str]

    stdout: Required[str]

    type: Required[Literal["code_execution_result"]]
