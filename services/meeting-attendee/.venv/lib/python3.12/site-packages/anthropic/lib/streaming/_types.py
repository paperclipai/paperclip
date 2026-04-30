from typing import TYPE_CHECKING, Any, Dict, Union, Generic, cast
from typing_extensions import List, Literal, Annotated

import jiter

from ...types import (
    Message,
    ContentBlock,
    MessageDeltaEvent as RawMessageDeltaEvent,
    MessageStartEvent as RawMessageStartEvent,
    RawMessageStopEvent,
    ContentBlockDeltaEvent as RawContentBlockDeltaEvent,
    ContentBlockStartEvent as RawContentBlockStartEvent,
    RawContentBlockStopEvent,
)
from ..._models import BaseModel, GenericModel
from .._parse._response import ResponseFormatT
from ..._utils._transform import PropertyInfo
from ...types.parsed_message import ParsedMessage, ParsedContentBlock
from ...types.citations_delta import Citation


class TextEvent(BaseModel):
    type: Literal["text"]

    text: str
    """The text delta"""

    snapshot: str
    """The entire accumulated text"""

    def parsed_snapshot(self) -> Dict[str, Any]:
        return cast(Dict[str, Any], jiter.from_json(self.snapshot.encode("utf-8"), partial_mode="trailing-strings"))


class CitationEvent(BaseModel):
    type: Literal["citation"]

    citation: Citation
    """The new citation"""

    snapshot: List[Citation]
    """All of the accumulated citations"""


class ThinkingEvent(BaseModel):
    type: Literal["thinking"]

    thinking: str
    """The thinking delta"""

    snapshot: str
    """The accumulated thinking so far"""


class SignatureEvent(BaseModel):
    type: Literal["signature"]

    signature: str
    """The signature of the thinking block"""


class InputJsonEvent(BaseModel):
    type: Literal["input_json"]

    partial_json: str
    """A partial JSON string delta

    e.g. `'"San Francisco,'`
    """

    snapshot: object
    """The currently accumulated parsed object.


    e.g. `{'location': 'San Francisco, CA'}`
    """


class MessageStopEvent(RawMessageStopEvent):
    type: Literal["message_stop"]

    message: Message


class ContentBlockStopEvent(RawContentBlockStopEvent):
    type: Literal["content_block_stop"]

    content_block: ContentBlock


MessageStreamEvent = Annotated[
    Union[
        TextEvent,
        CitationEvent,
        ThinkingEvent,
        SignatureEvent,
        InputJsonEvent,
        RawMessageStartEvent,
        RawMessageDeltaEvent,
        MessageStopEvent,
        RawContentBlockStartEvent,
        RawContentBlockDeltaEvent,
        ContentBlockStopEvent,
    ],
    PropertyInfo(discriminator="type"),
]


class ParsedMessageStopEvent(RawMessageStopEvent, GenericModel, Generic[ResponseFormatT]):
    type: Literal["message_stop"]

    message: ParsedMessage[ResponseFormatT]


class ParsedContentBlockStopEvent(RawContentBlockStopEvent, GenericModel, Generic[ResponseFormatT]):
    type: Literal["content_block_stop"]

    if TYPE_CHECKING:
        content_block: ParsedContentBlock[ResponseFormatT]
    else:
        content_block: ParsedContentBlock


ParsedMessageStreamEvent = Annotated[
    Union[
        TextEvent,
        CitationEvent,
        ThinkingEvent,
        SignatureEvent,
        InputJsonEvent,
        RawMessageStartEvent,
        RawMessageDeltaEvent,
        ParsedMessageStopEvent[ResponseFormatT],
        RawContentBlockStartEvent,
        RawContentBlockDeltaEvent,
        ParsedContentBlockStopEvent[ResponseFormatT],
    ],
    PropertyInfo(discriminator="type"),
]
