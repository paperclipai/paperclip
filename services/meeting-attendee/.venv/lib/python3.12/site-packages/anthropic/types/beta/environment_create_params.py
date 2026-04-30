# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from typing_extensions import Required, Annotated, TypedDict

from ..._utils import PropertyInfo
from ..anthropic_beta_param import AnthropicBetaParam
from .beta_cloud_config_params import BetaCloudConfigParams

__all__ = ["EnvironmentCreateParams"]


class EnvironmentCreateParams(TypedDict, total=False):
    name: Required[str]
    """Human-readable name for the environment"""

    config: Optional[BetaCloudConfigParams]
    """Request params for `cloud` environment configuration.

    Fields default to null; on update, omitted fields preserve the existing value.
    """

    description: Optional[str]
    """Optional description of the environment"""

    metadata: Dict[str, str]
    """User-provided metadata key-value pairs"""

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""
