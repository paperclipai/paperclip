# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Iterable
from typing_extensions import Literal, Required, TypedDict

from .beta_code_execution_output_block_param import BetaCodeExecutionOutputBlockParam

__all__ = ["BetaEncryptedCodeExecutionResultBlockParam"]


class BetaEncryptedCodeExecutionResultBlockParam(TypedDict, total=False):
    """Code execution result with encrypted stdout for PFC + web_search results."""

    content: Required[Iterable[BetaCodeExecutionOutputBlockParam]]

    encrypted_stdout: Required[str]

    return_code: Required[int]

    stderr: Required[str]

    type: Required[Literal["encrypted_code_execution_result"]]
