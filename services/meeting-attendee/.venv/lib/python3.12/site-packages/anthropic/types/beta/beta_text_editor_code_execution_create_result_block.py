# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaTextEditorCodeExecutionCreateResultBlock"]


class BetaTextEditorCodeExecutionCreateResultBlock(BaseModel):
    is_file_update: bool

    type: Literal["text_editor_code_execution_create_result"]
