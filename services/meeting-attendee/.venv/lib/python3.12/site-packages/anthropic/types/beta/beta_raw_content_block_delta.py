# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ..._utils import PropertyInfo
from .beta_text_delta import BetaTextDelta
from .beta_thinking_delta import BetaThinkingDelta
from .beta_citations_delta import BetaCitationsDelta
from .beta_signature_delta import BetaSignatureDelta
from .beta_input_json_delta import BetaInputJSONDelta
from .beta_compaction_content_block_delta import BetaCompactionContentBlockDelta

__all__ = ["BetaRawContentBlockDelta"]

BetaRawContentBlockDelta: TypeAlias = Annotated[
    Union[
        BetaTextDelta,
        BetaInputJSONDelta,
        BetaCitationsDelta,
        BetaThinkingDelta,
        BetaSignatureDelta,
        BetaCompactionContentBlockDelta,
    ],
    PropertyInfo(discriminator="type"),
]
