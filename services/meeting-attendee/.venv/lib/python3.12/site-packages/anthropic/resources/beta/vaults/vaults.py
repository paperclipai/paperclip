# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from itertools import chain

import httpx

from .... import _legacy_response
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from .credentials import (
    Credentials,
    AsyncCredentials,
    CredentialsWithRawResponse,
    AsyncCredentialsWithRawResponse,
    CredentialsWithStreamingResponse,
    AsyncCredentialsWithStreamingResponse,
)
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ....types.beta import vault_list_params, vault_create_params, vault_update_params
from ...._base_client import AsyncPaginator, make_request_options
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.beta_managed_agents_vault import BetaManagedAgentsVault
from ....types.beta.beta_managed_agents_deleted_vault import BetaManagedAgentsDeletedVault

__all__ = ["Vaults", "AsyncVaults"]


class Vaults(SyncAPIResource):
    @cached_property
    def credentials(self) -> Credentials:
        return Credentials(self._client)

    @cached_property
    def with_raw_response(self) -> VaultsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return VaultsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> VaultsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return VaultsWithStreamingResponse(self)

    def create(
        self,
        *,
        display_name: str,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """Create Vault

        Args:
          display_name: Human-readable name for the vault.

        1-255 characters.

          metadata: Arbitrary key-value metadata to attach to the vault. Maximum 16 pairs, keys up
              to 64 chars, values up to 512 chars.

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
            "/v1/vaults?beta=true",
            body=maybe_transform(
                {
                    "display_name": display_name,
                    "metadata": metadata,
                },
                vault_create_params.VaultCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )

    def retrieve(
        self,
        vault_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """
        Get Vault

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
            path_template("/v1/vaults/{vault_id}?beta=true", vault_id=vault_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )

    def update(
        self,
        vault_id: str,
        *,
        display_name: Optional[str] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """Update Vault

        Args:
          display_name: Updated human-readable name for the vault.

        1-255 characters.

          metadata: Metadata patch. Set a key to a string to upsert it, or to null to delete it.
              Omitted keys are preserved.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
            path_template("/v1/vaults/{vault_id}?beta=true", vault_id=vault_id),
            body=maybe_transform(
                {
                    "display_name": display_name,
                    "metadata": metadata,
                },
                vault_update_params.VaultUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )

    def list(
        self,
        *,
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
    ) -> SyncPageCursor[BetaManagedAgentsVault]:
        """
        List Vaults

        Args:
          include_archived: Whether to include archived vaults in the results.

          limit: Maximum number of vaults to return per page. Defaults to 20, maximum 100.

          page: Opaque pagination token from a previous `list_vaults` response.

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
            "/v1/vaults?beta=true",
            page=SyncPageCursor[BetaManagedAgentsVault],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "include_archived": include_archived,
                        "limit": limit,
                        "page": page,
                    },
                    vault_list_params.VaultListParams,
                ),
            ),
            model=BetaManagedAgentsVault,
        )

    def delete(
        self,
        vault_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedVault:
        """
        Delete Vault

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
        return self._delete(
            path_template("/v1/vaults/{vault_id}?beta=true", vault_id=vault_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedVault,
        )

    def archive(
        self,
        vault_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """
        Archive Vault

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
            path_template("/v1/vaults/{vault_id}/archive?beta=true", vault_id=vault_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )


class AsyncVaults(AsyncAPIResource):
    @cached_property
    def credentials(self) -> AsyncCredentials:
        return AsyncCredentials(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncVaultsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncVaultsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncVaultsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncVaultsWithStreamingResponse(self)

    async def create(
        self,
        *,
        display_name: str,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """Create Vault

        Args:
          display_name: Human-readable name for the vault.

        1-255 characters.

          metadata: Arbitrary key-value metadata to attach to the vault. Maximum 16 pairs, keys up
              to 64 chars, values up to 512 chars.

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
            "/v1/vaults?beta=true",
            body=await async_maybe_transform(
                {
                    "display_name": display_name,
                    "metadata": metadata,
                },
                vault_create_params.VaultCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )

    async def retrieve(
        self,
        vault_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """
        Get Vault

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
            path_template("/v1/vaults/{vault_id}?beta=true", vault_id=vault_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )

    async def update(
        self,
        vault_id: str,
        *,
        display_name: Optional[str] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """Update Vault

        Args:
          display_name: Updated human-readable name for the vault.

        1-255 characters.

          metadata: Metadata patch. Set a key to a string to upsert it, or to null to delete it.
              Omitted keys are preserved.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
            path_template("/v1/vaults/{vault_id}?beta=true", vault_id=vault_id),
            body=await async_maybe_transform(
                {
                    "display_name": display_name,
                    "metadata": metadata,
                },
                vault_update_params.VaultUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )

    def list(
        self,
        *,
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
    ) -> AsyncPaginator[BetaManagedAgentsVault, AsyncPageCursor[BetaManagedAgentsVault]]:
        """
        List Vaults

        Args:
          include_archived: Whether to include archived vaults in the results.

          limit: Maximum number of vaults to return per page. Defaults to 20, maximum 100.

          page: Opaque pagination token from a previous `list_vaults` response.

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
            "/v1/vaults?beta=true",
            page=AsyncPageCursor[BetaManagedAgentsVault],
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                query=maybe_transform(
                    {
                        "include_archived": include_archived,
                        "limit": limit,
                        "page": page,
                    },
                    vault_list_params.VaultListParams,
                ),
            ),
            model=BetaManagedAgentsVault,
        )

    async def delete(
        self,
        vault_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedVault:
        """
        Delete Vault

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
        return await self._delete(
            path_template("/v1/vaults/{vault_id}?beta=true", vault_id=vault_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedVault,
        )

    async def archive(
        self,
        vault_id: str,
        *,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsVault:
        """
        Archive Vault

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
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
            path_template("/v1/vaults/{vault_id}/archive?beta=true", vault_id=vault_id),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsVault,
        )


class VaultsWithRawResponse:
    def __init__(self, vaults: Vaults) -> None:
        self._vaults = vaults

        self.create = _legacy_response.to_raw_response_wrapper(
            vaults.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            vaults.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            vaults.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            vaults.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            vaults.delete,
        )
        self.archive = _legacy_response.to_raw_response_wrapper(
            vaults.archive,
        )

    @cached_property
    def credentials(self) -> CredentialsWithRawResponse:
        return CredentialsWithRawResponse(self._vaults.credentials)


class AsyncVaultsWithRawResponse:
    def __init__(self, vaults: AsyncVaults) -> None:
        self._vaults = vaults

        self.create = _legacy_response.async_to_raw_response_wrapper(
            vaults.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            vaults.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            vaults.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            vaults.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            vaults.delete,
        )
        self.archive = _legacy_response.async_to_raw_response_wrapper(
            vaults.archive,
        )

    @cached_property
    def credentials(self) -> AsyncCredentialsWithRawResponse:
        return AsyncCredentialsWithRawResponse(self._vaults.credentials)


class VaultsWithStreamingResponse:
    def __init__(self, vaults: Vaults) -> None:
        self._vaults = vaults

        self.create = to_streamed_response_wrapper(
            vaults.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            vaults.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            vaults.update,
        )
        self.list = to_streamed_response_wrapper(
            vaults.list,
        )
        self.delete = to_streamed_response_wrapper(
            vaults.delete,
        )
        self.archive = to_streamed_response_wrapper(
            vaults.archive,
        )

    @cached_property
    def credentials(self) -> CredentialsWithStreamingResponse:
        return CredentialsWithStreamingResponse(self._vaults.credentials)


class AsyncVaultsWithStreamingResponse:
    def __init__(self, vaults: AsyncVaults) -> None:
        self._vaults = vaults

        self.create = async_to_streamed_response_wrapper(
            vaults.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            vaults.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            vaults.update,
        )
        self.list = async_to_streamed_response_wrapper(
            vaults.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            vaults.delete,
        )
        self.archive = async_to_streamed_response_wrapper(
            vaults.archive,
        )

    @cached_property
    def credentials(self) -> AsyncCredentialsWithStreamingResponse:
        return AsyncCredentialsWithStreamingResponse(self._vaults.credentials)
