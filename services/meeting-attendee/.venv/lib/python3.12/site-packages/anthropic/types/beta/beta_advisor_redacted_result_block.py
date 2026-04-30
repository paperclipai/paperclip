# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ..._models import BaseModel

__all__ = ["BetaAdvisorRedactedResultBlock"]


class BetaAdvisorRedactedResultBlock(BaseModel):
    encrypted_content: str
    """Opaque blob containing the advisor's output.

    Round-trip verbatim; do not inspect or modify.
    """

    type: Literal["advisor_redacted_result"]
