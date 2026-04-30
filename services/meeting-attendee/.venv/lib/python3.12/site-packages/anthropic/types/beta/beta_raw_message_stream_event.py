# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ..._utils import PropertyInfo
from .beta_raw_message_stop_event import BetaRawMessageStopEvent
from .beta_raw_message_delta_event import BetaRawMessageDeltaEvent
from .beta_raw_message_start_event import BetaRawMessageStartEvent
from .beta_raw_content_block_stop_event import BetaRawContentBlockStopEvent
from .beta_raw_content_block_delta_event import BetaRawContentBlockDeltaEvent
from .beta_raw_content_block_start_event import BetaRawContentBlockStartEvent

__all__ = ["BetaRawMessageStreamEvent"]

BetaRawMessageStreamEvent: TypeAlias = Annotated[
    Union[
        BetaRawMessageStartEvent,
        BetaRawMessageDeltaEvent,
        BetaRawMessageStopEvent,
        BetaRawContentBlockStartEvent,
        BetaRawContentBlockDeltaEvent,
        BetaRawContentBlockStopEvent,
    ],
    PropertyInfo(discriminator="type"),
]
