# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable
from typing_extensions import Literal, Required, TypedDict

from .bash_code_execution_output_block_param import BashCodeExecutionOutputBlockParam

__all__ = ["BashCodeExecutionResultBlockParam"]


class BashCodeExecutionResultBlockParam(TypedDict, total=False):
    content: Required[Iterable[BashCodeExecutionOutputBlockParam]]

    return_code: Required[int]

    stderr: Required[str]

    stdout: Required[str]

    type: Required[Literal["bash_code_execution_result"]]
