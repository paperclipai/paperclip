# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_text_block import BetaTextBlock
from .beta_thinking_block import BetaThinkingBlock
from .beta_tool_use_block import BetaToolUseBlock
from .beta_compaction_block import BetaCompactionBlock
from .beta_mcp_tool_use_block import BetaMCPToolUseBlock
from .beta_mcp_tool_result_block import BetaMCPToolResultBlock
from .beta_server_tool_use_block import BetaServerToolUseBlock
from .beta_container_upload_block import BetaContainerUploadBlock
from .beta_redacted_thinking_block import BetaRedactedThinkingBlock
from .beta_advisor_tool_result_block import BetaAdvisorToolResultBlock
from .beta_web_fetch_tool_result_block import BetaWebFetchToolResultBlock
from .beta_web_search_tool_result_block import BetaWebSearchToolResultBlock
from .beta_tool_search_tool_result_block import BetaToolSearchToolResultBlock
from .beta_code_execution_tool_result_block import BetaCodeExecutionToolResultBlock
from .beta_bash_code_execution_tool_result_block import BetaBashCodeExecutionToolResultBlock
from .beta_text_editor_code_execution_tool_result_block import BetaTextEditorCodeExecutionToolResultBlock

__all__ = ["BetaRawContentBlockStartEvent", "ContentBlock"]

ContentBlock: TypeAlias = Annotated[
    Union[
        BetaTextBlock,
        BetaThinkingBlock,
        BetaRedactedThinkingBlock,
        BetaToolUseBlock,
        BetaServerToolUseBlock,
        BetaWebSearchToolResultBlock,
        BetaWebFetchToolResultBlock,
        BetaAdvisorToolResultBlock,
        BetaCodeExecutionToolResultBlock,
        BetaBashCodeExecutionToolResultBlock,
        BetaTextEditorCodeExecutionToolResultBlock,
        BetaToolSearchToolResultBlock,
        BetaMCPToolUseBlock,
        BetaMCPToolResultBlock,
        BetaContainerUploadBlock,
        BetaCompactionBlock,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaRawContentBlockStartEvent(BaseModel):
    content_block: ContentBlock
    """Response model for a file uploaded to the container."""

    index: int

    type: Literal["content_block_start"]
