from typing import TYPE_CHECKING, Any, Dict, Union, Generic, cast
from typing_extensions import List, Literal, Annotated

import jiter

from ..._models import BaseModel, GenericModel
from ...types.beta import (
    BetaRawMessageStopEvent,
    BetaRawMessageDeltaEvent,
    BetaRawMessageStartEvent,
    BetaRawContentBlockStopEvent,
    BetaRawContentBlockDeltaEvent,
    BetaRawContentBlockStartEvent,
)
from .._parse._response import ResponseFormatT
from ..._utils._transform import PropertyInfo
from ...types.beta.parsed_beta_message import ParsedBetaMessage, ParsedBetaContentBlock
from ...types.beta.beta_citations_delta import Citation


class ParsedBetaTextEvent(BaseModel):
    type: Literal["text"]

    text: str
    """The text delta"""

    snapshot: str
    """The entire accumulated text"""

    def parsed_snapshot(self) -> Dict[str, Any]:
        return cast(Dict[str, Any], jiter.from_json(self.snapshot.encode("utf-8"), partial_mode="trailing-strings"))


class BetaCitationEvent(BaseModel):
    type: Literal["citation"]

    citation: Citation
    """The new citation"""

    snapshot: List[Citation]
    """All of the accumulated citations"""


class BetaThinkingEvent(BaseModel):
    type: Literal["thinking"]

    thinking: str
    """The thinking delta"""

    snapshot: str
    """The accumulated thinking so far"""


class BetaSignatureEvent(BaseModel):
    type: Literal["signature"]

    signature: str
    """The signature of the thinking block"""


class BetaInputJsonEvent(BaseModel):
    type: Literal["input_json"]

    partial_json: str
    """A partial JSON string delta

    e.g. `'"San Francisco,'`
    """

    snapshot: object
    """The currently accumulated parsed object.


    e.g. `{'location': 'San Francisco, CA'}`
    """


class BetaCompactionEvent(BaseModel):
    type: Literal["compaction"]

    content: Union[str, None]
    """The compaction content"""


class ParsedBetaMessageStopEvent(BetaRawMessageStopEvent, GenericModel, Generic[ResponseFormatT]):
    type: Literal["message_stop"]

    message: ParsedBetaMessage[ResponseFormatT]


class ParsedBetaContentBlockStopEvent(BetaRawContentBlockStopEvent, GenericModel, Generic[ResponseFormatT]):
    type: Literal["content_block_stop"]

    if TYPE_CHECKING:
        content_block: ParsedBetaContentBlock[ResponseFormatT]
    else:
        content_block: ParsedBetaContentBlock


ParsedBetaMessageStreamEvent = Annotated[
    Union[
        ParsedBetaTextEvent,
        BetaCitationEvent,
        BetaThinkingEvent,
        BetaSignatureEvent,
        BetaInputJsonEvent,
        BetaCompactionEvent,
        BetaRawMessageStartEvent,
        BetaRawMessageDeltaEvent,
        ParsedBetaMessageStopEvent[ResponseFormatT],
        BetaRawContentBlockStartEvent,
        BetaRawContentBlockDeltaEvent,
        ParsedBetaContentBlockStopEvent[ResponseFormatT],
    ],
    PropertyInfo(discriminator="type"),
]
