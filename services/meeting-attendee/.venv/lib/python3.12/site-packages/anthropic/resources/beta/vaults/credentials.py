# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import Dict, List, Optional
from itertools import chain

import httpx

from .... import _legacy_response
from ...._types import Body, Omit, Query, Headers, NotGiven, omit, not_given
from ...._utils import is_given, path_template, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....pagination import SyncPageCursor, AsyncPageCursor
from ...._base_client import AsyncPaginator, make_request_options
from ....types.beta.vaults import credential_list_params, credential_create_params, credential_update_params
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.vaults.beta_managed_agents_credential import BetaManagedAgentsCredential
from ....types.beta.vaults.beta_managed_agents_deleted_credential import BetaManagedAgentsDeletedCredential

__all__ = ["Credentials", "AsyncCredentials"]


class Credentials(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> CredentialsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return CredentialsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> CredentialsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return CredentialsWithStreamingResponse(self)

    def create(
        self,
        vault_id: str,
        *,
        auth: credential_create_params.Auth,
        display_name: Optional[str] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Create Credential

        Args:
          auth: Authentication details for creating a credential.

          display_name: Human-readable name for the credential. Up to 255 characters.

          metadata: Arbitrary key-value metadata to attach to the credential. Maximum 16 pairs, keys
              up to 64 chars, values up to 512 chars.

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
            path_template("/v1/vaults/{vault_id}/credentials?beta=true", vault_id=vault_id),
            body=maybe_transform(
                {
                    "auth": auth,
                    "display_name": display_name,
                    "metadata": metadata,
                },
                credential_create_params.CredentialCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )

    def retrieve(
        self,
        credential_id: str,
        *,
        vault_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Get Credential

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )

    def update(
        self,
        credential_id: str,
        *,
        vault_id: str,
        auth: credential_update_params.Auth | Omit = omit,
        display_name: Optional[str] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Update Credential

        Args:
          auth: Updated authentication details for a credential.

          display_name: Updated human-readable name for the credential. 1-255 characters.

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
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            body=maybe_transform(
                {
                    "auth": auth,
                    "display_name": display_name,
                    "metadata": metadata,
                },
                credential_update_params.CredentialUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )

    def list(
        self,
        vault_id: str,
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
    ) -> SyncPageCursor[BetaManagedAgentsCredential]:
        """
        List Credentials

        Args:
          include_archived: Whether to include archived credentials in the results.

          limit: Maximum number of credentials to return per page. Defaults to 20, maximum 100.

          page: Opaque pagination token from a previous `list_credentials` response.

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
        return self._get_api_list(
            path_template("/v1/vaults/{vault_id}/credentials?beta=true", vault_id=vault_id),
            page=SyncPageCursor[BetaManagedAgentsCredential],
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
                    credential_list_params.CredentialListParams,
                ),
            ),
            model=BetaManagedAgentsCredential,
        )

    def delete(
        self,
        credential_id: str,
        *,
        vault_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedCredential:
        """
        Delete Credential

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedCredential,
        )

    def archive(
        self,
        credential_id: str,
        *,
        vault_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Archive Credential

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}/archive?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )


class AsyncCredentials(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncCredentialsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncCredentialsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncCredentialsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncCredentialsWithStreamingResponse(self)

    async def create(
        self,
        vault_id: str,
        *,
        auth: credential_create_params.Auth,
        display_name: Optional[str] | Omit = omit,
        metadata: Dict[str, str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Create Credential

        Args:
          auth: Authentication details for creating a credential.

          display_name: Human-readable name for the credential. Up to 255 characters.

          metadata: Arbitrary key-value metadata to attach to the credential. Maximum 16 pairs, keys
              up to 64 chars, values up to 512 chars.

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
            path_template("/v1/vaults/{vault_id}/credentials?beta=true", vault_id=vault_id),
            body=await async_maybe_transform(
                {
                    "auth": auth,
                    "display_name": display_name,
                    "metadata": metadata,
                },
                credential_create_params.CredentialCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )

    async def retrieve(
        self,
        credential_id: str,
        *,
        vault_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Get Credential

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )

    async def update(
        self,
        credential_id: str,
        *,
        vault_id: str,
        auth: credential_update_params.Auth | Omit = omit,
        display_name: Optional[str] | Omit = omit,
        metadata: Optional[Dict[str, Optional[str]]] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Update Credential

        Args:
          auth: Updated authentication details for a credential.

          display_name: Updated human-readable name for the credential. 1-255 characters.

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
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            body=await async_maybe_transform(
                {
                    "auth": auth,
                    "display_name": display_name,
                    "metadata": metadata,
                },
                credential_update_params.CredentialUpdateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )

    def list(
        self,
        vault_id: str,
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
    ) -> AsyncPaginator[BetaManagedAgentsCredential, AsyncPageCursor[BetaManagedAgentsCredential]]:
        """
        List Credentials

        Args:
          include_archived: Whether to include archived credentials in the results.

          limit: Maximum number of credentials to return per page. Defaults to 20, maximum 100.

          page: Opaque pagination token from a previous `list_credentials` response.

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
        return self._get_api_list(
            path_template("/v1/vaults/{vault_id}/credentials?beta=true", vault_id=vault_id),
            page=AsyncPageCursor[BetaManagedAgentsCredential],
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
                    credential_list_params.CredentialListParams,
                ),
            ),
            model=BetaManagedAgentsCredential,
        )

    async def delete(
        self,
        credential_id: str,
        *,
        vault_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsDeletedCredential:
        """
        Delete Credential

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsDeletedCredential,
        )

    async def archive(
        self,
        credential_id: str,
        *,
        vault_id: str,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaManagedAgentsCredential:
        """
        Archive Credential

        Args:
          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        if not vault_id:
            raise ValueError(f"Expected a non-empty value for `vault_id` but received {vault_id!r}")
        if not credential_id:
            raise ValueError(f"Expected a non-empty value for `credential_id` but received {credential_id!r}")
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
            path_template(
                "/v1/vaults/{vault_id}/credentials/{credential_id}/archive?beta=true",
                vault_id=vault_id,
                credential_id=credential_id,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaManagedAgentsCredential,
        )


class CredentialsWithRawResponse:
    def __init__(self, credentials: Credentials) -> None:
        self._credentials = credentials

        self.create = _legacy_response.to_raw_response_wrapper(
            credentials.create,
        )
        self.retrieve = _legacy_response.to_raw_response_wrapper(
            credentials.retrieve,
        )
        self.update = _legacy_response.to_raw_response_wrapper(
            credentials.update,
        )
        self.list = _legacy_response.to_raw_response_wrapper(
            credentials.list,
        )
        self.delete = _legacy_response.to_raw_response_wrapper(
            credentials.delete,
        )
        self.archive = _legacy_response.to_raw_response_wrapper(
            credentials.archive,
        )


class AsyncCredentialsWithRawResponse:
    def __init__(self, credentials: AsyncCredentials) -> None:
        self._credentials = credentials

        self.create = _legacy_response.async_to_raw_response_wrapper(
            credentials.create,
        )
        self.retrieve = _legacy_response.async_to_raw_response_wrapper(
            credentials.retrieve,
        )
        self.update = _legacy_response.async_to_raw_response_wrapper(
            credentials.update,
        )
        self.list = _legacy_response.async_to_raw_response_wrapper(
            credentials.list,
        )
        self.delete = _legacy_response.async_to_raw_response_wrapper(
            credentials.delete,
        )
        self.archive = _legacy_response.async_to_raw_response_wrapper(
            credentials.archive,
        )


class CredentialsWithStreamingResponse:
    def __init__(self, credentials: Credentials) -> None:
        self._credentials = credentials

        self.create = to_streamed_response_wrapper(
            credentials.create,
        )
        self.retrieve = to_streamed_response_wrapper(
            credentials.retrieve,
        )
        self.update = to_streamed_response_wrapper(
            credentials.update,
        )
        self.list = to_streamed_response_wrapper(
            credentials.list,
        )
        self.delete = to_streamed_response_wrapper(
            credentials.delete,
        )
        self.archive = to_streamed_response_wrapper(
            credentials.archive,
        )


class AsyncCredentialsWithStreamingResponse:
    def __init__(self, credentials: AsyncCredentials) -> None:
        self._credentials = credentials

        self.create = async_to_streamed_response_wrapper(
            credentials.create,
        )
        self.retrieve = async_to_streamed_response_wrapper(
            credentials.retrieve,
        )
        self.update = async_to_streamed_response_wrapper(
            credentials.update,
        )
        self.list = async_to_streamed_response_wrapper(
            credentials.list,
        )
        self.delete = async_to_streamed_response_wrapper(
            credentials.delete,
        )
        self.archive = async_to_streamed_response_wrapper(
            credentials.archive,
        )
