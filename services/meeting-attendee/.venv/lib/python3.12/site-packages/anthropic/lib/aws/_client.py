from __future__ import annotations

from typing import Any, Mapping
from typing_extensions import Self, override

import httpx

from ..._types import NOT_GIVEN, Omit, Headers, Timeout, NotGiven
from ..._client import Anthropic, AsyncAnthropic
from ._credentials import (
    resolve_region,
    resolve_api_key,
    resolve_base_url,
    resolve_auth_mode,
    resolve_workspace_id,
    validate_credentials,
)
from ..._exceptions import AnthropicError
from ..._base_client import DEFAULT_MAX_RETRIES


class AnthropicAWS(Anthropic):
    aws_access_key: str | None
    aws_secret_key: str | None
    aws_region: str | None
    aws_profile: str | None
    aws_session_token: str | None
    workspace_id: str | None
    _use_sigv4: bool
    _skip_auth: bool

    def __init__(
        self,
        *,
        api_key: str | None = None,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        aws_session_token: str | None = None,
        workspace_id: str | None = None,
        skip_auth: bool = False,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        http_client: httpx.Client | None = None,
        _strict_response_validation: bool = False,
        # Passed through to parent but not used for AWS auth
        auth_token: str | None = None,
    ) -> None:
        self._skip_auth = skip_auth

        validate_credentials(aws_access_key=aws_access_key, aws_secret_key=aws_secret_key)

        if skip_auth:
            self._use_sigv4 = False
            resolved_api_key = None
        else:
            self._use_sigv4 = resolve_auth_mode(
                api_key=api_key,
                aws_access_key=aws_access_key,
                aws_secret_key=aws_secret_key,
                aws_profile=aws_profile,
            )
            resolved_api_key = resolve_api_key(api_key=api_key, use_sigv4=self._use_sigv4)

        resolved_region = resolve_region(aws_region)

        if self._use_sigv4 and resolved_region is None:
            raise AnthropicError(
                "No AWS region was provided. Set the `aws_region` argument or the `AWS_REGION`/`AWS_DEFAULT_REGION` environment variable."
            )

        self.aws_access_key = aws_access_key
        self.aws_secret_key = aws_secret_key
        self.aws_region = resolved_region
        self.aws_profile = aws_profile
        self.aws_session_token = aws_session_token

        if skip_auth:
            self.workspace_id = workspace_id
        else:
            resolved_workspace_id = resolve_workspace_id(workspace_id)
            if resolved_workspace_id is None:
                raise AnthropicError(
                    "No workspace ID found. Set the `workspace_id` argument or the `ANTHROPIC_AWS_WORKSPACE_ID` environment variable."
                )
            self.workspace_id = resolved_workspace_id

        if not skip_auth:
            resolved_base_url = resolve_base_url(
                str(base_url) if base_url is not None else None,
                region=resolved_region,
            )
            if resolved_base_url is None:
                raise AnthropicError(
                    "No AWS region was provided and no base_url was given. "
                    "Set the `aws_region` argument, the `AWS_REGION`/`AWS_DEFAULT_REGION` environment variable, "
                    "or provide a `base_url` directly."
                )
            base_url = resolved_base_url

        super().__init__(
            api_key=resolved_api_key,
            auth_token=auth_token,
            base_url=base_url,  # type: ignore[arg-type]
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            default_query=default_query,
            http_client=http_client,
            _strict_response_validation=_strict_response_validation,
        )

    @property
    @override
    def default_headers(self) -> dict[str, str | Omit]:
        headers = {**super().default_headers}
        if self.workspace_id is not None:
            headers["anthropic-workspace-id"] = self.workspace_id
        return headers

    @property
    @override
    def _api_key_auth(self) -> dict[str, str]:
        if self._use_sigv4 or self._skip_auth:
            return {}
        return super()._api_key_auth

    @override
    def _validate_headers(self, headers: Headers, custom_headers: Headers) -> None:
        if self._use_sigv4 or self._skip_auth:
            return
        super()._validate_headers(headers, custom_headers)

    @override
    def _prepare_request(self, request: httpx.Request) -> None:
        if not self._use_sigv4:
            return

        from ._auth import get_auth_headers

        data = request.read().decode()

        headers = get_auth_headers(
            method=request.method,
            url=str(request.url),
            headers=request.headers,
            aws_access_key=self.aws_access_key,
            aws_secret_key=self.aws_secret_key,
            aws_session_token=self.aws_session_token,
            region=self.aws_region,
            profile=self.aws_profile,
            data=data,
            service_name="aws-external-anthropic",
        )
        request.headers.update(headers)

    @override
    def copy(
        self,
        *,
        api_key: str | None = None,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        aws_session_token: str | None = None,
        workspace_id: str | None = None,
        skip_auth: bool | None = None,
        auth_token: str | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = NOT_GIVEN,
        http_client: httpx.Client | None = None,
        max_retries: int | NotGiven = NOT_GIVEN,
        default_headers: Mapping[str, str] | None = None,
        set_default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        set_default_query: Mapping[str, object] | None = None,
        _extra_kwargs: Mapping[str, Any] = {},
    ) -> Self:
        # If region is changing and no explicit base_url, let __init__ derive it
        resolved_base_url = base_url or (None if aws_region else self.base_url)

        return super().copy(
            api_key=api_key or self.api_key,
            auth_token=auth_token,
            base_url=resolved_base_url,
            timeout=timeout,
            http_client=http_client,
            max_retries=max_retries,
            default_headers=default_headers,
            set_default_headers=set_default_headers,
            default_query=default_query,
            set_default_query=set_default_query,
            _extra_kwargs={
                "aws_access_key": aws_access_key or self.aws_access_key,
                "aws_secret_key": aws_secret_key or self.aws_secret_key,
                "aws_region": aws_region or self.aws_region,
                "aws_profile": aws_profile or self.aws_profile,
                "aws_session_token": aws_session_token or self.aws_session_token,
                "workspace_id": workspace_id or self.workspace_id,
                "skip_auth": skip_auth if skip_auth is not None else self._skip_auth,
                **_extra_kwargs,
            },
        )

    with_options = copy


class AsyncAnthropicAWS(AsyncAnthropic):
    aws_access_key: str | None
    aws_secret_key: str | None
    aws_region: str | None
    aws_profile: str | None
    aws_session_token: str | None
    workspace_id: str | None
    _use_sigv4: bool
    _skip_auth: bool

    def __init__(
        self,
        *,
        api_key: str | None = None,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        aws_session_token: str | None = None,
        workspace_id: str | None = None,
        skip_auth: bool = False,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        http_client: httpx.AsyncClient | None = None,
        _strict_response_validation: bool = False,
        # Accepted for compatibility with AsyncAnthropic.copy() but not used
        auth_token: str | None = None,
    ) -> None:
        self._skip_auth = skip_auth

        validate_credentials(aws_access_key=aws_access_key, aws_secret_key=aws_secret_key)

        if skip_auth:
            self._use_sigv4 = False
            resolved_api_key = None
        else:
            self._use_sigv4 = resolve_auth_mode(
                api_key=api_key,
                aws_access_key=aws_access_key,
                aws_secret_key=aws_secret_key,
                aws_profile=aws_profile,
            )
            resolved_api_key = resolve_api_key(api_key=api_key, use_sigv4=self._use_sigv4)

        resolved_region = resolve_region(aws_region)

        if self._use_sigv4 and resolved_region is None:
            raise AnthropicError(
                "No AWS region was provided. Set the `aws_region` argument or the `AWS_REGION`/`AWS_DEFAULT_REGION` environment variable."
            )

        self.aws_access_key = aws_access_key
        self.aws_secret_key = aws_secret_key
        self.aws_region = resolved_region
        self.aws_profile = aws_profile
        self.aws_session_token = aws_session_token

        if skip_auth:
            self.workspace_id = workspace_id
        else:
            resolved_workspace_id = resolve_workspace_id(workspace_id)
            if resolved_workspace_id is None:
                raise AnthropicError(
                    "No workspace ID found. Set the `workspace_id` argument or the `ANTHROPIC_AWS_WORKSPACE_ID` environment variable."
                )
            self.workspace_id = resolved_workspace_id

        if not skip_auth:
            resolved_base_url = resolve_base_url(
                str(base_url) if base_url is not None else None,
                region=resolved_region,
            )
            if resolved_base_url is None:
                raise AnthropicError(
                    "No AWS region was provided and no base_url was given. "
                    "Set the `aws_region` argument, the `AWS_REGION`/`AWS_DEFAULT_REGION` environment variable, "
                    "or provide a `base_url` directly."
                )
            base_url = resolved_base_url

        super().__init__(
            api_key=resolved_api_key,
            auth_token=auth_token,
            base_url=base_url,  # type: ignore[arg-type]
            timeout=timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            default_query=default_query,
            http_client=http_client,
            _strict_response_validation=_strict_response_validation,
        )

    @property
    @override
    def default_headers(self) -> dict[str, str | Omit]:
        headers = {**super().default_headers}
        if self.workspace_id is not None:
            headers["anthropic-workspace-id"] = self.workspace_id
        return headers

    @property
    @override
    def _api_key_auth(self) -> dict[str, str]:
        if self._use_sigv4 or self._skip_auth:
            return {}
        return super()._api_key_auth

    @override
    def _validate_headers(self, headers: Headers, custom_headers: Headers) -> None:
        if self._use_sigv4 or self._skip_auth:
            return
        super()._validate_headers(headers, custom_headers)

    @override
    async def _prepare_request(self, request: httpx.Request) -> None:
        if not self._use_sigv4:
            return

        from ._auth import get_auth_headers

        data = request.read().decode()

        headers = get_auth_headers(
            method=request.method,
            url=str(request.url),
            headers=request.headers,
            aws_access_key=self.aws_access_key,
            aws_secret_key=self.aws_secret_key,
            aws_session_token=self.aws_session_token,
            region=self.aws_region,
            profile=self.aws_profile,
            data=data,
            service_name="aws-external-anthropic",
        )
        request.headers.update(headers)

    @override
    def copy(
        self,
        *,
        api_key: str | None = None,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        aws_session_token: str | None = None,
        workspace_id: str | None = None,
        skip_auth: bool | None = None,
        auth_token: str | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = NOT_GIVEN,
        http_client: httpx.AsyncClient | None = None,
        max_retries: int | NotGiven = NOT_GIVEN,
        default_headers: Mapping[str, str] | None = None,
        set_default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        set_default_query: Mapping[str, object] | None = None,
        _extra_kwargs: Mapping[str, Any] = {},
    ) -> Self:
        # If region is changing and no explicit base_url, let __init__ derive it
        resolved_base_url = base_url or (None if aws_region else self.base_url)

        return super().copy(
            api_key=api_key or self.api_key,
            auth_token=auth_token,
            base_url=resolved_base_url,
            timeout=timeout,
            http_client=http_client,
            max_retries=max_retries,
            default_headers=default_headers,
            set_default_headers=set_default_headers,
            default_query=default_query,
            set_default_query=set_default_query,
            _extra_kwargs={
                "aws_access_key": aws_access_key or self.aws_access_key,
                "aws_secret_key": aws_secret_key or self.aws_secret_key,
                "aws_region": aws_region or self.aws_region,
                "aws_profile": aws_profile or self.aws_profile,
                "aws_session_token": aws_session_token or self.aws_session_token,
                "workspace_id": workspace_id or self.workspace_id,
                "skip_auth": skip_auth if skip_auth is not None else self._skip_auth,
                **_extra_kwargs,
            },
        )

    with_options = copy
