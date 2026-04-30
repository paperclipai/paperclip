# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Union, Iterable, Optional
from datetime import datetime
from itertools import chain

import httpx

from .... import _legacy_response
from .versions import (
    Versions,
    AsyncVersions,
    VersionsWithRawResponse,
    AsyncVersionsWithRawResponse,
    VersionsWithStreamingResponse,
    AsyncVersionsWithStreamingResponse,
)
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ....types.beta import agent_list_params, agent_create_params, agent_update_params, agent_retrieve_params
from ...._base_client import AsyncPaginator, make_request_options
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.beta_managed_agents_agent import BetaManagedAgentsAgent
from ....types.beta.beta_managed_agents_skill_params import BetaManagedAgentsSkillParams
from ....types.beta.beta_managed_agents_url_mcp_server_params import BetaManagedAgentsURLMCPServerParams

__all__ = ["Agents", "AsyncAgents"]


class Agents(SyncAPIResource):
    @cached_property
    def versions(self) -> Versions:
        return Versions(self._client)

    @cached_property
    def with_raw_response(self) -> AgentsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AgentsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AgentsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AgentsWithStreamingResponse(self)

    def create(
        self,
        *,
        model: agent_create_params.Model,
        name: str,
        description: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaManagedAgentsURLMCPServerParams] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        skills: Iterable[BetaManagedAgentsSkillParams] | Omit = omit,
        system: Optional[str] | Omit = omit,
        tools: Iterable[agent_create_params.Tool] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """Create Agent

        Args:
          model: Model identifier.

        Accepts the
              [model string](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison),
              e.g. `claude-opus-4-6`, or a `model_config` object for additional configuration
              control

          name: Human-readable name for the agent. 1-256 characters.

          description: Description of what the agent does. Up to 2048 characters.

          mcp_servers: MCP servers this agent connects to. Maximum 20. Names must be unique within the
              array.

          metadata: Arbitrary key-value metadata. Maximum 16 pairs, keys up to 64 chars, values up
              to 512 chars.

          skills: Skills available to the agent. Maximum 20.

          system: System prompt for the agent. Up to 100,000 characters.

          tools: Tool configurations available to the agent. Maximum of 128 tools across all
              toolsets allowed.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._post(
            "/v1/agents?beta=true",
            body=maybe_transform(
                {
                    "model": model,
                    "name": name,
                    "description": description,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "skills": skills,
                    "system": system,
                    "tools": tools,
                },
                agent_create_params.AgentCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsAgent,
        )

    def retrieve(
        self,
        agent_id: str,
        *,
        version: int | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """Get Agent

        Args:
          version: Agent version.

        Omit for the most recent version. Must be at least 1 if
              specified.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._get(
            path_template("/v1/agents/{agent_id}?beta=true", agent_id=agent_id),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform({"version": version}, agent_retrieve_params.AgentRetrieveParams),
            ),
            cast_to=BetaManagedAgentsAgent,
        )

    def update(
        self,
        agent_id: str,
        *,
        version: int,
        description: Optional[str] | Omit = omit,
        mcp_servers: Optional[Iterable[BetaManagedAgentsURLMCPServerParams]] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        model: agent_update_params.Model | Omit = omit,
        name: str | Omit = omit,
        skills: Optional[Iterable[BetaManagedAgentsSkillParams]] | Omit = omit,
        system: Optional[str] | Omit = omit,
        tools: Optional[Iterable[agent_update_params.Tool]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """
        Update Agent

        Args:
          version: The agent's current version, used to prevent concurrent overwrites. Obtain this
              value from a create or retrieve response. The request fails if this does not
              match the server's current version.

          description: Description. Up to 2048 characters. Omit to preserve; send empty string or null
              to clear.

          mcp_servers: MCP servers. Full replacement. Omit to preserve; send empty array or null to
              clear. Names must be unique. Maximum 20.

          metadata: Metadata patch. Set a key to a string to upsert it, or to null to delete it.
              Omit the field to preserve. The stored bag is limited to 16 keys (up to 64 chars
              each) with values up to 512 chars.

          model: Model identifier. Accepts the
              [model string](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison),
              e.g. `claude-opus-4-6`, or a `model_config` object for additional configuration
              control. Omit to preserve. Cannot be cleared.

          name: Human-readable name. 1-256 characters. Omit to preserve. Cannot be cleared.

          skills: Skills. Full replacement. Omit to preserve; send empty array or null to clear.
              Maximum 20.

          system: System prompt. Up to 100,000 characters. Omit to preserve; send empty string or
              null to clear.

          tools: Tool configurations available to the agent. Full replacement. Omit to preserve;
              send empty array or null to clear. Maximum of 128 tools across all toolsets
              allowed.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._post(
            path_template("/v1/agents/{agent_id}?beta=true", agent_id=agent_id),
            body=maybe_transform(
                {
                    "version": version,
                    "description": description,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "model": model,
                    "name": name,
                    "skills": skills,
                    "system": system,
                    "tools": tools,
                },
                agent_update_params.AgentUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsAgent,
        )

    def list(
        self,
        *,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        include_archived: bool | Omit = omit,
        limit: int | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> SyncPageCursor[BetaManagedAgentsAgent]:
        """
        List Agents

        Args:
          created_at_gte: Return agents created at or after this time (inclusive).

          created_at_lte: Return agents created at or before this time (inclusive).

          include_archived: Include archived agents in results. Defaults to false.

          limit: Maximum results per page. Default 20, maximum 100.

          page: Opaque pagination cursor from a previous response.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._get_api_list(
            "/v1/agents?beta=true",
            page=SyncPageCursor[BetaManagedAgentsAgent],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "created_at_gte": created_at_gte,
                        "created_at_lte": created_at_lte,
                        "include_archived": include_archived,
                        "limit": limit,
                        "page": page,
                    },
                    agent_list_params.AgentListParams,
                ),
            ),
            model=BetaManagedAgentsAgent,
        )

    def archive(
        self,
        agent_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """
        Archive Agent

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._post(
            path_template("/v1/agents/{agent_id}/archive?beta=true", agent_id=agent_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsAgent,
        )


class AsyncAgents(AsyncAPIResource):
    @cached_property
    def versions(self) -> AsyncVersions:
        return AsyncVersions(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncAgentsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncAgentsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncAgentsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncAgentsWithStreamingResponse(self)

    async def create(
        self,
        *,
        model: agent_create_params.Model,
        name: str,
        description: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaManagedAgentsURLMCPServerParams] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        skills: Iterable[BetaManagedAgentsSkillParams] | Omit = omit,
        system: Optional[str] | Omit = omit,
        tools: Iterable[agent_create_params.Tool] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """Create Agent

        Args:
          model: Model identifier.

        Accepts the
              [model string](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison),
              e.g. `claude-opus-4-6`, or a `model_config` object for additional configuration
              control

          name: Human-readable name for the agent. 1-256 characters.

          description: Description of what the agent does. Up to 2048 characters.

          mcp_servers: MCP servers this agent connects to. Maximum 20. Names must be unique within the
              array.

          metadata: Arbitrary key-value metadata. Maximum 16 pairs, keys up to 64 chars, values up
              to 512 chars.

          skills: Skills available to the agent. Maximum 20.

          system: System prompt for the agent. Up to 100,000 characters.

          tools: Tool configurations available to the agent. Maximum of 128 tools across all
              toolsets allowed.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._post(
            "/v1/agents?beta=true",
            body=await async_maybe_transform(
                {
                    "model": model,
                    "name": name,
                    "description": description,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "skills": skills,
                    "system": system,
                    "tools": tools,
                },
                agent_create_params.AgentCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsAgent,
        )

    async def retrieve(
        self,
        agent_id: str,
        *,
        version: int | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """Get Agent

        Args:
          version: Agent version.

        Omit for the most recent version. Must be at least 1 if
              specified.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._get(
            path_template("/v1/agents/{agent_id}?beta=true", agent_id=agent_id),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=await async_maybe_transform({"version": version}, agent_retrieve_params.AgentRetrieveParams),
            ),
            cast_to=BetaManagedAgentsAgent,
        )

    async def update(
        self,
        agent_id: str,
        *,
        version: int,
        description: Optional[str] | Omit = omit,
        mcp_servers: Optional[Iterable[BetaManagedAgentsURLMCPServerParams]] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        model: agent_update_params.Model | Omit = omit,
        name: str | Omit = omit,
        skills: Optional[Iterable[BetaManagedAgentsSkillParams]] | Omit = omit,
        system: Optional[str] | Omit = omit,
        tools: Optional[Iterable[agent_update_params.Tool]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """
        Update Agent

        Args:
          version: The agent's current version, used to prevent concurrent overwrites. Obtain this
              value from a create or retrieve response. The request fails if this does not
              match the server's current version.

          description: Description. Up to 2048 characters. Omit to preserve; send empty string or null
              to clear.

          mcp_servers: MCP servers. Full replacement. Omit to preserve; send empty array or null to
              clear. Names must be unique. Maximum 20.

          metadata: Metadata patch. Set a key to a string to upsert it, or to null to delete it.
              Omit the field to preserve. The stored bag is limited to 16 keys (up to 64 chars
              each) with values up to 512 chars.

          model: Model identifier. Accepts the
              [model string](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison),
              e.g. `claude-opus-4-6`, or a `model_config` object for additional configuration
              control. Omit to preserve. Cannot be cleared.

          name: Human-readable name. 1-256 characters. Omit to preserve. Cannot be cleared.

          skills: Skills. Full replacement. Omit to preserve; send empty array or null to clear.
              Maximum 20.

          system: System prompt. Up to 100,000 characters. Omit to preserve; send empty string or
              null to clear.

          tools: Tool configurations available to the agent. Full replacement. Omit to preserve;
              send empty array or null to clear. Maximum of 128 tools across all toolsets
              allowed.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._post(
            path_template("/v1/agents/{agent_id}?beta=true", agent_id=agent_id),
            body=await async_maybe_transform(
                {
                    "version": version,
                    "description": description,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "model": model,
                    "name": name,
                    "skills": skills,
                    "system": system,
                    "tools": tools,
                },
                agent_update_params.AgentUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsAgent,
        )

    def list(
        self,
        *,
        created_at_gte: Union[str, datetime] | Omit = omit,
        created_at_lte: Union[str, datetime] | Omit = omit,
        include_archived: bool | Omit = omit,
        limit: int | Omit = omit,
        page: str | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncPaginator[BetaManagedAgentsAgent, AsyncPageCursor[BetaManagedAgentsAgent]]:
        """
        List Agents

        Args:
          created_at_gte: Return agents created at or after this time (inclusive).

          created_at_lte: Return agents created at or before this time (inclusive).

          include_archived: Include archived agents in results. Defaults to false.

          limit: Maximum results per page. Default 20, maximum 100.

          page: Opaque pagination cursor from a previous response.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return self._get_api_list(
            "/v1/agents?beta=true",
            page=AsyncPageCursor[BetaManagedAgentsAgent],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "created_at_gte": created_at_gte,
                        "created_at_lte": created_at_lte,
                        "include_archived": include_archived,
                        "limit": limit,
                        "page": page,
                    },
                    agent_list_params.AgentListParams,
                ),
            ),
            model=BetaManagedAgentsAgent,
        )

    async def archive(
        self,
        agent_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsAgent:
        """
        Archive Agent

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not agent_id:
            raise ValueError(f"Expected a non-empty value for `agent_id` but received {agent_id!r}")
        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["managed-agents-2026-04-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "managed-agents-2026-04-01", **(extra_headers or {})}
        return await self._post(
            path_template("/v1/agents/{agent_id}/archive?beta=true", agent_id=agent_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsAgent,
        )


class AgentsWithRawResponse:
    def __init__(self, agents: Agents) -> None:
        self._agents = agents

        self.create = _legacy_response.to_raw_response_wrapper(
            agents.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            agents.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            agents.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            agents.list,
        )
        self.archive = _legacy_response.to_raw_response_wrapper(
            agents.archive,
        )

    @cached_property
    def versions(self) -> VersionsWithRawResponse:
        return VersionsWithRawResponse(self._agents.versions)


class AsyncAgentsWithRawResponse:
    def __init__(self, agents: AsyncAgents) -> None:
        self._agents = agents

        self.create = _legacy_response.async_to_raw_response_wrapper(
            agents.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            agents.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            agents.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            agents.list,
        )
        self.archive = _legacy_response.async_to_raw_response_wrapper(
            agents.archive,
        )

    @cached_property
    def versions(self) -> AsyncVersionsWithRawResponse:
        return AsyncVersionsWithRawResponse(self._agents.versions)


class AgentsWithStreamingResponse:
    def __init__(self, agents: Agents) -> None:
        self._agents = agents

        self.create = to_streamed_response_wrapper(
            agents.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            agents.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            agents.update,
        )
        self.list = to_streamed_response_wrapper(
            agents.list,
        )
        self.archive = to_streamed_response_wrapper(
            agents.archive,
        )

    @cached_property
    def versions(self) -> VersionsWithStreamingResponse:
        return VersionsWithStreamingResponse(self._agents.versions)


class AsyncAgentsWithStreamingResponse:
    def __init__(self, agents: AsyncAgents) -> None:
        self._agents = agents

        self.create = async_to_streamed_response_wrapper(
            agents.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            agents.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            agents.update,
        )
        self.list = async_to_streamed_response_wrapper(
            agents.list,
        )
        self.archive = async_to_streamed_response_wrapper(
            agents.archive,
        )

    @cached_property
    def versions(self) -> AsyncVersionsWithStreamingResponse:
        return AsyncVersionsWithStreamingResponse(self._agents.versions)
