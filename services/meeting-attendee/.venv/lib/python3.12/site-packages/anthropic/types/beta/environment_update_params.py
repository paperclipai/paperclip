# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from typing_extensions import Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam
from .beta_cloud_config_params import BetaCloudConfigParams

__all__ = ["EnvironmentUpdateParams"]


class EnvironmentUpdateParams(TypedDict, total=False):
    config: Optional[BetaCloudConfigParams]
    """Request params for `cloud` environment configuration.

    Fields default to null; on update, omitted fields preserve the existing value.
    """

    description: Optional[str]
    """Updated description of the environment"""

    metadata: Dict[str, Optional[str]]
    """User-provided metadata key-value pairs.

    Set a value to null or empty string to delete the key.
    """

    name: Optional[str]
    """Updated name for the environment"""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
