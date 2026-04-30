# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel
from ..beta_message import BetaMessage

__all__ = ["BetaMessageBatchSucceededResult"]


class BetaMessageBatchSucceededResult(BaseModel):
    message: BetaMessage

    type: Literal["succeeded"]
