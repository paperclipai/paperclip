# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from .._utils import PropertyInfo
from .text_delta import TextDelta
from .thinking_delta import ThinkingDelta
from .citations_delta import CitationsDelta
from .signature_delta import SignatureDelta
from .input_json_delta import InputJSONDelta

__all__ = ["RawContentBlockDelta"]

RawContentBlockDelta: TypeAlias = Annotated[
    Union[TextDelta, InputJSONDelta, CitationsDelta, ThinkingDelta, SignatureDelta], PropertyInfo(discriminator="type")
]
