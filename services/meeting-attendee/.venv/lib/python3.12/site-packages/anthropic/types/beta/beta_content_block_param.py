# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union
from typing_extensions import TypeAlias

from .beta_content_block import BetaContentBlock
from .beta_text_block_param import BetaTextBlockParam
from .beta_image_block_param import BetaImageBlockParam
from .beta_thinking_block_param import BetaThinkingBlockParam
from .beta_tool_use_block_param import BetaToolUseBlockParam
from .beta_compaction_block_param import BetaCompactionBlockParam
from .beta_tool_result_block_param import BetaToolResultBlockParam
from .beta_mcp_tool_use_block_param import BetaMCPToolUseBlockParam
from .beta_search_result_block_param import BetaSearchResultBlockParam
from .beta_server_tool_use_block_param import BetaServerToolUseBlockParam
from .beta_container_upload_block_param import BetaContainerUploadBlockParam
from .beta_request_document_block_param import BetaRequestDocumentBlockParam
from .beta_redacted_thinking_block_param import BetaRedactedThinkingBlockParam
from .beta_advisor_tool_result_block_param import BetaAdvisorToolResultBlockParam
from .beta_web_fetch_tool_result_block_param import BetaWebFetchToolResultBlockParam
from .beta_web_search_tool_result_block_param import BetaWebSearchToolResultBlockParam
from .beta_request_mcp_tool_result_block_param import BetaRequestMCPToolResultBlockParam
from .beta_tool_search_tool_result_block_param import BetaToolSearchToolResultBlockParam
from .beta_code_execution_tool_result_block_param import BetaCodeExecutionToolResultBlockParam
from .beta_bash_code_execution_tool_result_block_param import BetaBashCodeExecutionToolResultBlockParam
from .beta_text_editor_code_execution_tool_result_block_param import BetaTextEditorCodeExecutionToolResultBlockParam

__all__ = ["BetaContentBlockParam"]

BetaContentBlockParam: TypeAlias = Union[
    BetaTextBlockParam,
    BetaImageBlockParam,
    BetaRequestDocumentBlockParam,
    BetaSearchResultBlockParam,
    BetaThinkingBlockParam,
    BetaRedactedThinkingBlockParam,
    BetaToolUseBlockParam,
    BetaToolResultBlockParam,
    BetaServerToolUseBlockParam,
    BetaWebSearchToolResultBlockParam,
    BetaWebFetchToolResultBlockParam,
    BetaAdvisorToolResultBlockParam,
    BetaCodeExecutionToolResultBlockParam,
    BetaBashCodeExecutionToolResultBlockParam,
    BetaTextEditorCodeExecutionToolResultBlockParam,
    BetaToolSearchToolResultBlockParam,
    BetaMCPToolUseBlockParam,
    BetaRequestMCPToolResultBlockParam,
    BetaContainerUploadBlockParam,
    BetaCompactionBlockParam,
    BetaContentBlock,
]
