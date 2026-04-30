# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing_extensions import Literal, Required, TypedDict

from .beta_managed_agents_custom_tool_input_schema_param import BetaManagedAgentsCustomToolInputSchemaParam

__all__ = ["BetaManagedAgentsCustomToolParams"]


class BetaManagedAgentsCustomToolParams(TypedDict, total=False):
    """A custom tool that is executed by the API client rather than the agent.

    When the agent calls this tool, an `agent.custom_tool_use` event is emitted and the session goes idle, waiting for the client to provide the result via a `user.custom_tool_result` event.
    """

    description: Required[str]
    """
    Description of what the tool does, shown to the agent to help it decide when to
    use the tool. 1-1024 characters.
    """

    input_schema: Required[BetaManagedAgentsCustomToolInputSchemaParam]
    """JSON Schema for custom tool input parameters."""

    name: Required[str]
    """Unique name for the tool.

    1-128 characters; letters, digits, underscores, and hyphens.
    """

    type: Required[Literal["custom"]]
