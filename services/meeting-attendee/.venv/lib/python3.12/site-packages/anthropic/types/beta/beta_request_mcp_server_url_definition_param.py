# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Optional
from typing_extensions import Literal, Required, TypedDict

from .beta_request_mcp_server_tool_configuration_param import BetaRequestMCPServerToolConfigurationParam

__all__ = ["BetaRequestMCPServerURLDefinitionParam"]


class BetaRequestMCPServerURLDefinitionParam(TypedDict, total=False):
    name: Required[str]

    type: Required[Literal["url"]]

    url: Required[str]

    authorization_token: Optional[str]

    tool_configuration: Optional[BetaRequestMCPServerToolConfigurationParam]
