from __future__ import annotations

import os
import logging
import urllib.parse
from typing import Any, Union, Mapping, TypeVar
from typing_extensions import Self, override

import httpx

from ... import _exceptions
from ._beta import Beta, AsyncBeta
from ..._types import NOT_GIVEN, Timeout, NotGiven
from ..._utils import is_dict, is_given
from ..._compat import model_copy
from ..._version import __version__
from ..._streaming import Stream, AsyncStream
from ..._exceptions import AnthropicError, APIStatusError
from ..._base_client import (
    DEFAULT_MAX_RETRIES,
    BaseClient,
    SyncAPIClient,
    AsyncAPIClient,
    FinalRequestOptions,
)
from ._stream_decoder import AWSEventStreamDecoder
from ...resources.messages import Messages, AsyncMessages
from ...resources.completions import Completions, AsyncCompletions

log: logging.Logger = logging.getLogger(__name__)

DEFAULT_VERSION = "bedrock-2023-05-31"

_HttpxClientT = TypeVar("_HttpxClientT", bound=Union[httpx.Client, httpx.AsyncClient])
_DefaultStreamT = TypeVar("_DefaultStreamT", bound=Union[Stream[Any], AsyncStream[Any]])


def _prepare_options(input_options: FinalRequestOptions) -> FinalRequestOptions:
    options = model_copy(input_options, deep=True)

    if is_dict(options.json_data):
        options.json_data.setdefault("anthropic_version", DEFAULT_VERSION)

        if is_given(options.headers):
            betas = options.headers.get("anthropic-beta")
            if betas:
                options.json_data.setdefault("anthropic_beta", betas.split(","))

    if options.url in {"/v1/complete", "/v1/messages", "/v1/messages?beta=true"} and options.method == "post":
        if not is_dict(options.json_data):
            raise RuntimeError("Expected dictionary json_data for post /completions endpoint")

        model = options.json_data.pop("model", None)
        model = urllib.parse.quote(str(model), safe=":")
        stream = options.json_data.pop("stream", False)
        if stream:
            options.url = f"/model/{model}/invoke-with-response-stream"
        else:
            options.url = f"/model/{model}/invoke"

    if options.url.startswith("/v1/messages/batches"):
        raise AnthropicError("The Batch API is not supported in Bedrock yet")

    if options.url == "/v1/messages/count_tokens":
        raise AnthropicError("Token counting is not supported in Bedrock yet")

    return options


def _infer_region() -> str:
    """
    Infer the AWS region from the environment variables or
    from the boto3 session if available.
    """
    aws_region = os.environ.get("AWS_REGION")
    if aws_region is None:
        try:
            import boto3

            session = boto3.Session()
            if session.region_name:
                aws_region = session.region_name
        except ImportError:
            pass

    if aws_region is None:
        log.warning("No AWS region specified, defaulting to us-east-1")
        aws_region = "us-east-1"  # fall back to legacy behavior

    return aws_region


class BaseBedrockClient(BaseClient[_HttpxClientT, _DefaultStreamT]):
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

        if response.status_code == 422:
            return _exceptions.UnprocessableEntityError(err_msg, response=response, body=body)

        if response.status_code == 429:
            return _exceptions.RateLimitError(err_msg, response=response, body=body)

        if response.status_code == 503:
            return _exceptions.ServiceUnavailableError(err_msg, response=response, body=body)

        if response.status_code >= 500:
            return _exceptions.InternalServerError(err_msg, response=response, body=body)
        return APIStatusError(err_msg, response=response, body=body)


class AnthropicBedrock(BaseBedrockClient[httpx.Client, Stream[Any]], SyncAPIClient):
    messages: Messages
    completions: Completions
    beta: Beta

    def __init__(
        self,
        aws_secret_key: str | None = None,
        aws_access_key: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        aws_session_token: str | None = None,
        api_key: str | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        # Configure a custom httpx client. See the [httpx documentation](https://www.python-httpx.org/api/#client) for more details.
        http_client: httpx.Client | None = None,
        # Enable or disable schema validation for data returned by the API.
        # When enabled an error APIResponseValidationError is raised
        # if the API responds with invalid data for the expected schema.
        #
        # This parameter may be removed or changed in the future.
        # If you rely on this feature, please open a GitHub issue
        # outlining your use-case to help us decide if it should be
        # part of our public interface in the future.
        _strict_response_validation: bool = False,
    ) -> None:
        if api_key is None:
            api_key = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")

        has_aws_credentials = (
            aws_access_key is not None
            or aws_secret_key is not None
            or aws_session_token is not None
            or aws_profile is not None
        )
        if api_key is not None and has_aws_credentials:
            raise ValueError(
                "Cannot specify both `api_key` and AWS credentials (`aws_access_key`, `aws_secret_key`, `aws_session_token`, `aws_profile`)"
            )

        self.api_key: str | None = api_key

        self.aws_secret_key = aws_secret_key

        self.aws_access_key = aws_access_key

        self.aws_region = _infer_region() if aws_region is None else aws_region
        self.aws_profile = aws_profile

        self.aws_session_token = aws_session_token

        if base_url is None:
            base_url = os.environ.get("ANTHROPIC_BEDROCK_BASE_URL")
        if base_url is None:
            base_url = f"https://bedrock-runtime.{self.aws_region}.amazonaws.com"

        super().__init__(
            version=__version__,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            custom_headers=default_headers,
            custom_query=default_query,
            http_client=http_client,
            _strict_response_validation=_strict_response_validation,
        )

        self.beta = Beta(self)
        self.messages = Messages(self)
        self.completions = Completions(self)

    @override
    def _make_sse_decoder(self) -> AWSEventStreamDecoder:
        return AWSEventStreamDecoder()

    @override
    def _prepare_options(self, options: FinalRequestOptions) -> FinalRequestOptions:
        return _prepare_options(options)

    @override
    def _prepare_request(self, request: httpx.Request) -> None:
        if self.api_key is not None:
            request.headers["Authorization"] = f"Bearer {self.api_key}"
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
            region=self.aws_region or "us-east-1",
            profile=self.aws_profile,
            data=data,
        )
        request.headers.update(headers)

    def copy(
        self,
        *,
        aws_secret_key: str | None = None,
        aws_access_key: str | None = None,
        aws_region: str | None = None,
        aws_session_token: str | None = None,
        api_key: str | None = None,
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
        """
        Create a new client instance re-using the same options given to the current client with optional overriding.
        """
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
            aws_secret_key=aws_secret_key or self.aws_secret_key,
            aws_access_key=aws_access_key or self.aws_access_key,
            aws_region=aws_region or self.aws_region,
            aws_session_token=aws_session_token or self.aws_session_token,
            api_key=api_key or self.api_key,
            base_url=base_url or self.base_url,
            timeout=self.timeout if isinstance(timeout, NotGiven) else timeout,
            http_client=http_client,
            max_retries=max_retries if is_given(max_retries) else self.max_retries,
            default_headers=headers,
            default_query=params,
            **_extra_kwargs,
        )

    # Alias for `copy` for nicer inline usage, e.g.
    # client.with_options(timeout=10).foo.create(...)
    with_options = copy


class AsyncAnthropicBedrock(BaseBedrockClient[httpx.AsyncClient, AsyncStream[Any]], AsyncAPIClient):
    messages: AsyncMessages
    completions: AsyncCompletions
    beta: AsyncBeta

    def __init__(
        self,
        aws_secret_key: str | None = None,
        aws_access_key: str | None = None,
        aws_region: str | None = None,
        aws_profile: str | None = None,
        aws_session_token: str | None = None,
        api_key: str | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        # Configure a custom httpx client. See the [httpx documentation](https://www.python-httpx.org/api/#client) for more details.
        http_client: httpx.AsyncClient | None = None,
        # Enable or disable schema validation for data returned by the API.
        # When enabled an error APIResponseValidationError is raised
        # if the API responds with invalid data for the expected schema.
        #
        # This parameter may be removed or changed in the future.
        # If you rely on this feature, please open a GitHub issue
        # outlining your use-case to help us decide if it should be
        # part of our public interface in the future.
        _strict_response_validation: bool = False,
    ) -> None:
        if api_key is None:
            api_key = os.environ.get("AWS_BEARER_TOKEN_BEDROCK")

        has_aws_credentials = (
            aws_access_key is not None
            or aws_secret_key is not None
            or aws_session_token is not None
            or aws_profile is not None
        )
        if api_key is not None and has_aws_credentials:
            raise ValueError(
                "Cannot specify both `api_key` and AWS credentials (`aws_access_key`, `aws_secret_key`, `aws_session_token`, `aws_profile`)"
            )

        self.api_key: str | None = api_key

        self.aws_secret_key = aws_secret_key

        self.aws_access_key = aws_access_key

        self.aws_region = _infer_region() if aws_region is None else aws_region
        self.aws_profile = aws_profile

        self.aws_session_token = aws_session_token

        if base_url is None:
            base_url = os.environ.get("ANTHROPIC_BEDROCK_BASE_URL")
        if base_url is None:
            base_url = f"https://bedrock-runtime.{self.aws_region}.amazonaws.com"

        super().__init__(
            version=__version__,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            custom_headers=default_headers,
            custom_query=default_query,
            http_client=http_client,
            _strict_response_validation=_strict_response_validation,
        )

        self.messages = AsyncMessages(self)
        self.completions = AsyncCompletions(self)
        self.beta = AsyncBeta(self)

    @override
    def _make_sse_decoder(self) -> AWSEventStreamDecoder:
        return AWSEventStreamDecoder()

    @override
    async def _prepare_options(self, options: FinalRequestOptions) -> FinalRequestOptions:
        return _prepare_options(options)

    @override
    async def _prepare_request(self, request: httpx.Request) -> None:
        if self.api_key is not None:
            request.headers["Authorization"] = f"Bearer {self.api_key}"
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
            region=self.aws_region or "us-east-1",
            profile=self.aws_profile,
            data=data,
        )
        request.headers.update(headers)

    def copy(
        self,
        *,
        aws_secret_key: str | None = None,
        aws_access_key: str | None = None,
        aws_region: str | None = None,
        aws_session_token: str | None = None,
        api_key: str | None = None,
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
        """
        Create a new client instance re-using the same options given to the current client with optional overriding.
        """
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
            aws_secret_key=aws_secret_key or self.aws_secret_key,
            aws_access_key=aws_access_key or self.aws_access_key,
            aws_region=aws_region or self.aws_region,
            aws_session_token=aws_session_token or self.aws_session_token,
            api_key=api_key or self.api_key,
            base_url=base_url or self.base_url,
            timeout=self.timeout if isinstance(timeout, NotGiven) else timeout,
            http_client=http_client,
            max_retries=max_retries if is_given(max_retries) else self.max_retries,
            default_headers=headers,
            default_query=params,
            **_extra_kwargs,
        )

    # Alias for `copy` for nicer inline usage, e.g.
    # client.with_options(timeout=10).foo.create(...)
    with_options = copy
