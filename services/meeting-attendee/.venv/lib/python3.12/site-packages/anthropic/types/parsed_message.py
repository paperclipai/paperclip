from __future__ import annotations

from typing import TYPE_CHECKING, List, Union, Generic, Optional
from typing_extensions import TypeVar, Annotated, TypeAlias

from .._utils import PropertyInfo
from .message import Message
from .text_block import TextBlock
from .thinking_block import ThinkingBlock
from .tool_use_block import ToolUseBlock
from .server_tool_use_block import ServerToolUseBlock
from .redacted_thinking_block import RedactedThinkingBlock
from .web_search_tool_result_block import WebSearchToolResultBlock

ResponseFormatT = TypeVar("ResponseFormatT", default=None)


__all__ = [
    "ParsedTextBlock",
    "ParsedContentBlock",
    "ParsedMessage",
]


class ParsedTextBlock(TextBlock, Generic[ResponseFormatT]):
    parsed_output: Optional[ResponseFormatT] = None

    __api_exclude__ = {"parsed_output"}


# Note that generic unions are not valid for pydantic at runtime
ParsedContentBlock: TypeAlias = Annotated[
    Union[
        ParsedTextBlock[ResponseFormatT],
        ThinkingBlock,
        RedactedThinkingBlock,
        ToolUseBlock,
        ServerToolUseBlock,
        WebSearchToolResultBlock,
    ],
    PropertyInfo(discriminator="type"),
]


class ParsedMessage(Message, Generic[ResponseFormatT]):
    if TYPE_CHECKING:
        content: List[ParsedContentBlock[ResponseFormatT]]  # type: ignore[assignment]
    else:
        content: List[ParsedContentBlock]

    @property
    def parsed_output(self) -> Optional[ResponseFormatT]:
        for content in self.content:
            if content.type == "text" and content.parsed_output:
                return content.parsed_output
        return None
