# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ...._utils import PropertyInfo
from ...._models import BaseModel
from .beta_managed_agents_url_image_source import BetaManagedAgentsURLImageSource
from .beta_managed_agents_file_image_source import BetaManagedAgentsFileImageSource
from .beta_managed_agents_base64_image_source import BetaManagedAgentsBase64ImageSource

__all__ = ["BetaManagedAgentsImageBlock", "Source"]

Source: TypeAlias = Annotated[
    Union[BetaManagedAgentsBase64ImageSource, BetaManagedAgentsURLImageSource, BetaManagedAgentsFileImageSource],
    PropertyInfo(discriminator="type"),
]


class BetaManagedAgentsImageBlock(BaseModel):
    """Image content specified directly as base64 data or as a reference via a URL."""

    source: Source
    """Union type for image source variants."""

    type: Literal["image"]
