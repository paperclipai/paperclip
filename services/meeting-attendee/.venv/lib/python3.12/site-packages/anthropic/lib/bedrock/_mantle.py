from __future__ import annotations

import os
from typing import Any, Union, Mapping, TypeVar
from typing_extensions import Self, override

import httpx

from ... import _exceptions
from ..._qs import Querystring
from ..._types import NOT_GIVEN, Omit, Timeout, NotGiven
from ..._utils import is_given
from ..._compat import cached_property
from ..._version import __version__
from ..aws._auth import get_auth_headers
from ..._resource import SyncAPIResource, AsyncAPIResource
from ..._streaming import Stream, AsyncStream
from ..._exceptions import AnthropicError, APIStatusError
from ..._base_client import (
    DEFAULT_MAX_RETRIES,
    BaseClient,
    SyncAPIClient,
    AsyncAPIClient,
)
from ..aws._credentials import (
    resolve_region,
    resolve_api_key,
    resolve_auth_mode,
    validate_credentials,
)
from ...resources.messages import Messages, AsyncMessages
from ...resources.beta.messages import Messages as BetaMessages, AsyncMessages as AsyncBetaMessages

DEFAULT_SERVICE_NAME = "bedrock-mantle"

_MANTLE_API_KEY_ENV_VARS = ("AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_AWS_API_KEY")

_HttpxClientT = TypeVar("_HttpxClientT", bound=Union[httpx.Client, httpx.AsyncClient])
_DefaultStreamT = TypeVar("_DefaultStreamT", bound=Union[Stream[Any], AsyncStream[Any]])


# --- Beta resources (messages-only) ---


class MantleBeta(SyncAPIResource):
    @cached_property
    def messages(self) -> BetaMessages:
        return BetaMessages(self._client)


class AsyncMantleBeta(AsyncAPIResource):
    @cached_property
    def messages(self) -> AsyncBetaMessages:
        return AsyncBetaMessages(self._client)


# --- Base ---


class BaseMantleClient(BaseClient[_HttpxClientT, _DefaultStreamT]):
    @override
    def _make_status_error(
        self,
        err_msg: str,
        *,
        body: object,
        response: httpx.Response,
    ) -> APIStatusError:
        if response.status_code == 400:
            return _exceptions.BadRequestError(err_msg, response=response, body=body)

        if response.status_code == 401:
            return _exceptions.AuthenticationError(err_msg, response=response, body=body)

        if response.status_code == 403:
            return _exceptions.PermissionDeniedError(err_msg, response=response, body=body)

        if response.status_code == 404:
            return _exceptions.NotFoundError(err_msg, response=response, body=body)

        if response.status_code == 409:
            return _exceptions.ConflictError(err_msg, response=response, body=body)

        if response.status_code == 413:
            return _exceptions.RequestTooLargeError(err_msg, response=response, body=body)

        if response.status_code == 422:
            return _exceptions.UnprocessableEntityError(err_msg, response=response, body=body)

        if response.status_code == 429:
            return _exceptions.RateLimitError(err_msg, response=response, body=body)

        if response.status_code == 529:
            return _exceptions.OverloadedError(err_msg, response=response, body=body)

        if response.status_code >= 500:
            return _exceptions.InternalServerError(err_msg, response=response, body=body)
        return APIStatusError(err_msg, response=response, body=body)


# --- Shared init logic ---


def _resolve_mantle_config(
    *,
    api_key: str | None,
    aws_access_key: str | None,
    aws_secret_key: str | None,
    aws_region: str | None,
    aws_profile: str | None,
    skip_auth: bool,
    base_url: str | httpx.URL | None,
    default_headers: Mapping[str, str] | None,
) -> tuple[str | None, str | httpx.URL, bool, dict[str, str]]:
    """Resolve and validate all Mantle client configuration.

    Returns (resolved_api_key, resolved_base_url, use_sigv4, merged_headers).
    """
    if skip_auth:
        use_sigv4 = False
        resolved_api_key = None
    else:
        validate_credentials(aws_access_key=aws_access_key, aws_secret_key=aws_secret_key)

        use_sigv4 = resolve_auth_mode(
            api_key=api_key,
            aws_access_key=aws_access_key,
            aws_secret_key=aws_secret_key,
            aws_profile=aws_profile,
            api_key_env_vars=_MANTLE_API_KEY_ENV_VARS,
        )

        resolved_api_key = resolve_api_key(
            api_key=api_key,
            use_sigv4=use_sigv4,
            api_key_env_vars=_MANTLE_API_KEY_ENV_VARS,
        )

    resolved_region = resolve_region(aws_region)

    if base_url is None:
        base_url = os.environ.get("ANTHROPIC_BEDROCK_MANTLE_BASE_URL")
    if base_url is None:
        if resolved_region is None:
            raise AnthropicError(
                "No AWS region or base URL found. Set `aws_region` in the constructor, "
                "the `AWS_REGION` / `AWS_DEFAULT_REGION` environment variable, or provide "
                "a `base_url` / `ANTHROPIC_BEDROCK_MANTLE_BASE_URL` environment variable."
            )
        base_url = f"https://bedrock-mantle.{resolved_region}.api.aws/anthropic"

    merged_headers: dict[str, str] = {}
    if default_headers:
        merged_headers.update(default_headers)

    return resolved_api_key, base_url, use_sigv4, merged_headers


# --- Sync client ---


class AnthropicBedrockMantle(BaseMantleClient[httpx.Client, Stream[Any]], SyncAPIClient):
    messages: Messages
    beta: MantleBeta

    aws_region: str | None
    aws_access_key: str | None
    aws_secret_key: str | None
    aws_session_token: str | None
    aws_profile: str | None
    skip_auth: bool

    _use_sigv4: bool

    def __init__(
        self,
        *,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_session_token: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        api_key: str | None = None,
        skip_auth: bool = False,
        base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        http_client: httpx.Client | None = None,
        _strict_response_validation: bool = False,
    ) -> None:
        resolved_api_key, resolved_base_url, use_sigv4, merged_headers = _resolve_mantle_config(
            api_key=api_key,
            aws_access_key=aws_access_key,
            aws_secret_key=aws_secret_key,
            aws_region=aws_region,
            aws_profile=aws_profile,
            skip_auth=skip_auth,
            base_url=base_url,
            default_headers=default_headers,
        )

        resolved_region = resolve_region(aws_region)

        super().__init__(
            version=__version__,
            base_url=resolved_base_url,
            timeout=timeout,
            max_retries=max_retries,
            custom_headers=merged_headers,
            custom_query=default_query,
            http_client=http_client,
            _strict_response_validation=_strict_response_validation,
        )

        self.api_key = resolved_api_key
        self.aws_region = resolved_region
        self.aws_access_key = aws_access_key
        self.aws_secret_key = aws_secret_key
        self.aws_session_token = aws_session_token
        self.aws_profile = aws_profile
        self.skip_auth = skip_auth
        self._use_sigv4 = use_sigv4

        self.messages = Messages(self)
        self.beta = MantleBeta(self)

    @property
    @override
    def qs(self) -> Querystring:
        return Querystring(array_format="comma")

    @property
    @override
    def auth_headers(self) -> dict[str, str]:
        if self.skip_auth or self._use_sigv4:
            return {}
        api_key = self.api_key
        if api_key is None:
            return {}
        return {"Authorization": f"Bearer {api_key}"}

    @property
    @override
    def default_headers(self) -> dict[str, str | Omit]:
        return {
            **super().default_headers,
            "X-Stainless-Async": "false",
            "anthropic-version": "2023-06-01",
            **self._custom_headers,
        }

    @override
    def _validate_headers(self, headers: Any, custom_headers: Any) -> None:
        pass

    @override
    def _prepare_request(self, request: httpx.Request) -> None:
        if self.skip_auth or not self._use_sigv4:
            return

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
            service_name=DEFAULT_SERVICE_NAME,
        )
        request.headers.update(headers)

    def copy(
        self,
        *,
        api_key: str | None = None,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_session_token: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        skip_auth: bool | None = None,
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
        if default_headers is not None and set_default_headers is not None:
            raise ValueError("The `default_headers` and `set_default_headers` arguments are mutually exclusive")

        if default_query is not None and set_default_query is not None:
            raise ValueError("The `default_query` and `set_default_query` arguments are mutually exclusive")

        headers = self._custom_headers
        if default_headers is not None:
            headers = {**headers, **default_headers}
        elif set_default_headers is not None:
            headers = set_default_headers

        params = self._custom_query
        if default_query is not None:
            params = {**params, **default_query}
        elif set_default_query is not None:
            params = set_default_query

        return self.__class__(
            api_key=api_key or self.api_key,
            aws_access_key=aws_access_key or self.aws_access_key,
            aws_secret_key=aws_secret_key or self.aws_secret_key,
            aws_session_token=aws_session_token or self.aws_session_token,
            aws_region=aws_region or self.aws_region,
            aws_profile=aws_profile or self.aws_profile,
            skip_auth=skip_auth if skip_auth is not None else self.skip_auth,
            base_url=base_url or self.base_url,
            timeout=self.timeout if isinstance(timeout, NotGiven) else timeout,
            http_client=http_client,
            max_retries=max_retries if is_given(max_retries) else self.max_retries,
            default_headers=headers,
            default_query=params,
            **_extra_kwargs,
        )

    with_options = copy


# --- Async client ---


class AsyncAnthropicBedrockMantle(BaseMantleClient[httpx.AsyncClient, AsyncStream[Any]], AsyncAPIClient):
    messages: AsyncMessages
    beta: AsyncMantleBeta

    aws_region: str | None
    aws_access_key: str | None
    aws_secret_key: str | None
    aws_session_token: str | None
    aws_profile: str | None
    skip_auth: bool

    _use_sigv4: bool

    def __init__(
        self,
        *,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_session_token: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        api_key: str | None = None,
        skip_auth: bool = False,
        base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        http_client: httpx.AsyncClient | None = None,
        _strict_response_validation: bool = False,
    ) -> None:
        resolved_api_key, resolved_base_url, use_sigv4, merged_headers = _resolve_mantle_config(
            api_key=api_key,
            aws_access_key=aws_access_key,
            aws_secret_key=aws_secret_key,
            aws_region=aws_region,
            aws_profile=aws_profile,
            skip_auth=skip_auth,
            base_url=base_url,
            default_headers=default_headers,
        )

        resolved_region = resolve_region(aws_region)

        super().__init__(
            version=__version__,
            base_url=resolved_base_url,
            timeout=timeout,
            max_retries=max_retries,
            custom_headers=merged_headers,
            custom_query=default_query,
            http_client=http_client,
            _strict_response_validation=_strict_response_validation,
        )

        self.api_key = resolved_api_key
        self.aws_region = resolved_region
        self.aws_access_key = aws_access_key
        self.aws_secret_key = aws_secret_key
        self.aws_session_token = aws_session_token
        self.aws_profile = aws_profile
        self.skip_auth = skip_auth
        self._use_sigv4 = use_sigv4

        self.messages = AsyncMessages(self)
        self.beta = AsyncMantleBeta(self)

    @property
    @override
    def qs(self) -> Querystring:
        return Querystring(array_format="comma")

    @property
    @override
    def auth_headers(self) -> dict[str, str]:
        if self.skip_auth or self._use_sigv4:
            return {}
        api_key = self.api_key
        if api_key is None:
            return {}
        return {"Authorization": f"Bearer {api_key}"}

    @property
    @override
    def default_headers(self) -> dict[str, str | Omit]:
        return {
            **super().default_headers,
            "X-Stainless-Async": "async:asyncio",
            "anthropic-version": "2023-06-01",
            **self._custom_headers,
        }

    @override
    def _validate_headers(self, headers: Any, custom_headers: Any) -> None:
        pass

    @override
    async def _prepare_request(self, request: httpx.Request) -> None:
        if self.skip_auth or not self._use_sigv4:
            return

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
            service_name=DEFAULT_SERVICE_NAME,
        )
        request.headers.update(headers)

    def copy(
        self,
        *,
        api_key: str | None = None,
        aws_access_key: str | None = None,
        aws_secret_key: str | None = None,
        aws_session_token: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        skip_auth: bool | None = None,
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
        if default_headers is not None and set_default_headers is not None:
            raise ValueError("The `default_headers` and `set_default_headers` arguments are mutually exclusive")

        if default_query is not None and set_default_query is not None:
            raise ValueError("The `default_query` and `set_default_query` arguments are mutually exclusive")

        headers = self._custom_headers
        if default_headers is not None:
            headers = {**headers, **default_headers}
        elif set_default_headers is not None:
            headers = set_default_headers

        params = self._custom_query
        if default_query is not None:
            params = {**params, **default_query}
        elif set_default_query is not None:
            params = set_default_query

        return self.__class__(
            api_key=api_key or self.api_key,
            aws_access_key=aws_access_key or self.aws_access_key,
            aws_secret_key=aws_secret_key or self.aws_secret_key,
            aws_session_token=aws_session_token or self.aws_session_token,
            aws_region=aws_region or self.aws_region,
            aws_profile=aws_profile or self.aws_profile,
            skip_auth=skip_auth if skip_auth is not None else self.skip_auth,
            base_url=base_url or self.base_url,
            timeout=self.timeout if isinstance(timeout, NotGiven) else timeout,
            http_client=http_client,
            max_retries=max_retries if is_given(max_retries) else self.max_retries,
            default_headers=headers,
            default_query=params,
            **_extra_kwargs,
        )

    with_options = copy
