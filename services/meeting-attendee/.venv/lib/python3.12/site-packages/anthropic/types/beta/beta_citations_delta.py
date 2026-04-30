# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_citation_char_location import BetaCitationCharLocation
from .beta_citation_page_location import BetaCitationPageLocation
from .beta_citation_content_block_location import BetaCitationContentBlockLocation
from .beta_citation_search_result_location import BetaCitationSearchResultLocation
from .beta_citations_web_search_result_location import BetaCitationsWebSearchResultLocation

__all__ = ["BetaCitationsDelta", "Citation"]

Citation: TypeAlias = Annotated[
    Union[
        BetaCitationCharLocation,
        BetaCitationPageLocation,
        BetaCitationContentBlockLocation,
        BetaCitationsWebSearchResultLocation,
        BetaCitationSearchResultLocation,
    ],
    PropertyInfo(discriminator="type"),
]


class BetaCitationsDelta(BaseModel):
    citation: Citation

    type: Literal["citations_delta"]
