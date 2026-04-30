# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing_extensions import Literal

from ...._models import BaseModel

__all__ = ["BetaManagedAgentsAPIActor"]


class BetaManagedAgentsAPIActor(BaseModel):
    api_key_id: str

    type: Literal["api_actor"]
