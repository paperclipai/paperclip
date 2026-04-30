# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Union, Optional
from typing_extensions import Literal, Required, TypeAlias, TypedDict

from .beta_packages_params import BetaPackagesParams
from .beta_limited_network_params import BetaLimitedNetworkParams
from .beta_unrestricted_network_param import BetaUnrestrictedNetworkParam

__all__ = ["BetaCloudConfigParams", "Networking"]

Networking: TypeAlias = Union[BetaUnrestrictedNetworkParam, BetaLimitedNetworkParams]


class BetaCloudConfigParams(TypedDict, total=False):
    """Request params for `cloud` environment configuration.

    Fields default to null; on update, omitted fields preserve the
    existing value.
    """

    type: Required[Literal["cloud"]]
    """Environment type"""

    networking: Optional[Networking]
    """Network configuration policy. Omit on update to preserve the existing value."""

    packages: Optional[BetaPackagesParams]
    """Specify packages (and optionally their versions) available in this environment.

    When versioning, use the version semantics relevant for the package manager,
    e.g. for `pip` use `package==1.0.0`. You are responsible for validating the
    package and version exist. Unversioned installs the latest.
    """
