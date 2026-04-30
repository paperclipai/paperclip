from typing_extensions import TypeAlias

from ._types import (
    TextEvent as TextEvent,
    InputJsonEvent as InputJsonEvent,
    MessageStopEvent as MessageStopEvent,
    MessageStreamEvent as MessageStreamEvent,
    ContentBlockStopEvent as ContentBlockStopEvent,
    ParsedMessageStopEvent as ParsedMessageStopEvent,
    ParsedMessageStreamEvent as ParsedMessageStreamEvent,
    ParsedContentBlockStopEvent as ParsedContentBlockStopEvent,
)
from ._messages import (
    MessageStream as MessageStream,
    AsyncMessageStream as AsyncMessageStream,
    MessageStreamManager as MessageStreamManager,
    AsyncMessageStreamManager as AsyncMessageStreamManager,
)
from ._beta_types import (
    BetaInputJsonEvent as BetaInputJsonEvent,
    ParsedBetaTextEvent as ParsedBetaTextEvent,
    ParsedBetaMessageStopEvent as ParsedBetaMessageStopEvent,
    ParsedBetaMessageStreamEvent as ParsedBetaMessageStreamEvent,
    ParsedBetaContentBlockStopEvent as ParsedBetaContentBlockStopEvent,
)

# For backwards compatibility
BetaTextEvent: TypeAlias = ParsedBetaTextEvent
BetaMessageStopEvent: TypeAlias = ParsedBetaMessageStopEvent[object]
BetaMessageStreamEvent: TypeAlias = ParsedBetaMessageStreamEvent
BetaContentBlockStopEvent: TypeAlias = ParsedBetaContentBlockStopEvent[object]


from ._beta_messages import (
    BetaMessageStream as BetaMessageStream,
    BetaAsyncMessageStream as BetaAsyncMessageStream,
    BetaMessageStreamManager as BetaMessageStreamManager,
    BetaAsyncMessageStreamManager as BetaAsyncMessageStreamManager,
)
