from __future__ import annotations

from typing import TYPE_CHECKING, List, Union, Generic, Optional
from typing_extensions import TypeVar, Annotated, TypeAlias

from ..._utils import PropertyInfo
from .beta_message import BetaMessage
from .beta_text_block import BetaTextBlock
from .beta_thinking_block import BetaThinkingBlock
from .beta_tool_use_block import BetaToolUseBlock
from .beta_compaction_block import BetaCompactionBlock
from .beta_mcp_tool_use_block import BetaMCPToolUseBlock
from .beta_mcp_tool_result_block import BetaMCPToolResultBlock
from .beta_server_tool_use_block import BetaServerToolUseBlock
from .beta_container_upload_block import BetaContainerUploadBlock
from .beta_redacted_thinking_block import BetaRedactedThinkingBlock
from .beta_web_search_tool_result_block import BetaWebSearchToolResultBlock
from .beta_code_execution_tool_result_block import BetaCodeExecutionToolResultBlock
from .beta_bash_code_execution_tool_result_block import BetaBashCodeExecutionToolResultBlock
from .beta_text_editor_code_execution_tool_result_block import BetaTextEditorCodeExecutionToolResultBlock

ResponseFormatT = TypeVar("ResponseFormatT", default=None)


__all__ = [
    "ParsedBetaTextBlock",
    "ParsedBetaContentBlock",
    "ParsedBetaMessage",
]


class ParsedBetaTextBlock(BetaTextBlock, Generic[ResponseFormatT]):
    parsed_output: Optional[ResponseFormatT] = None

    __api_exclude__ = {"parsed_output"}


# Note that generic unions are not valid for pydantic at runtime
ParsedBetaContentBlock: TypeAlias = Annotated[
    Union[
        ParsedBetaTextBlock[ResponseFormatT],
        BetaThinkingBlock,
        BetaRedactedThinkingBlock,
        BetaToolUseBlock,
        BetaServerToolUseBlock,
        BetaWebSearchToolResultBlock,
        BetaCodeExecutionToolResultBlock,
        BetaBashCodeExecutionToolResultBlock,
        BetaTextEditorCodeExecutionToolResultBlock,
        BetaMCPToolUseBlock,
        BetaMCPToolResultBlock,
        BetaContainerUploadBlock,
        BetaCompactionBlock,
    ],
    PropertyInfo(discriminator="type"),
]


class ParsedBetaMessage(BetaMessage, Generic[ResponseFormatT]):
    if TYPE_CHECKING:
        content: List[ParsedBetaContentBlock[ResponseFormatT]]  # type: ignore[assignment]
    else:
        content: List[ParsedBetaContentBlock]

    @property
    def parsed_output(self) -> Optional[ResponseFormatT]:
        for content in self.content:
            if content.type == "text" and content.parsed_output:
                return content.parsed_output
        return None
