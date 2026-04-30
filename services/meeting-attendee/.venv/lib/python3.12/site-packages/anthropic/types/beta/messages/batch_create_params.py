# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Iterable, Optional
from typing_extensions import Required, Annotated, TypedDict

from ...._utils import PropertyInfo
from ...anthropic_beta_param import AnthropicBetaParam
from ..message_create_params import MessageCreateParamsNonStreaming

__all__ = ["BatchCreateParams", "Request"]


class BatchCreateParams(TypedDict, total=False):
    requests: Required[Iterable[Request]]
    """List of requests for prompt completion.

    Each is an individual request to create a Message.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""



    user_profile_id: Optional[str]
    """The user profile ID to attribute this request to.

    Use when acting on behalf of a party other than your organization.
    """


class Request(TypedDict, total=False):
    custom_id: Required[str]
    """Developer-provided ID created for each request in a Message Batch.

    Useful for matching results to requests, as results may be given out of request
    order.

    Must be unique for each request within the Message Batch.
    """

    params: Required[MessageCreateParamsNonStreaming]
    """Messages API creation parameters for the individual request.

    See the [Messages API reference](https://docs.claude.com/en/api/messages) for
    full documentation on available parameters.
    """
