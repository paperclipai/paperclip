# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from .._models import BaseModel

__all__ = ["BashCodeExecutionOutputBlock"]


class BashCodeExecutionOutputBlock(BaseModel):
    file_id: str

    type: Literal["bash_code_execution_output"]
