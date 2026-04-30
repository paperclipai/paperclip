# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Literal, Annotated, TypeAlias

from ..._utils import PropertyInfo
from ..._models import BaseModel
from .beta_packages import BetaPackages
from .beta_limited_network import BetaLimitedNetwork
from .beta_unrestricted_network import BetaUnrestrictedNetwork

__all__ = ["BetaCloudConfig", "Networking"]

Networking: TypeAlias = Annotated[
    Union[BetaUnrestrictedNetwork, BetaLimitedNetwork], PropertyInfo(discriminator="type")
]


class BetaCloudConfig(BaseModel):
    """`cloud` environment configuration."""

    networking: Networking
    """Network configuration policy."""

    packages: BetaPackages
    """Package manager configuration."""

    type: Literal["cloud"]
    """Environment type"""
