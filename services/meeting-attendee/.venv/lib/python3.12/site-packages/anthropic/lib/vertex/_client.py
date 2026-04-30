from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Union, Mapping, TypeVar
from typing_extensions import Self, override

import httpx

from ... import _exceptions
from ._auth import load_auth, refresh_auth
from ._beta import Beta, AsyncBeta
from ..._types import NOT_GIVEN, NotGiven
from ..._utils import is_dict, asyncify, is_given
from ..._compat import model_copy, typed_cached_property
from ..._models import FinalRequestOptions
from ..._version import __version__
from ..._streaming import Stream, AsyncStream
from ..._exceptions import AnthropicError, APIStatusError
from ..._base_client import (
    DEFAULT_MAX_RETRIES,
    BaseClient,
    SyncAPIClient,
    AsyncAPIClient,
)
from ...resources.messages import Messages, AsyncMessages

if TYPE_CHECKING:
    from google.auth.credentials import Credentials as GoogleCredentials  # type: ignore


DEFAULT_VERSION = "vertex-2023-10-16"

_HttpxClientT = TypeVar("_HttpxClientT", bound=Union[httpx.Client, httpx.AsyncClient])
_DefaultStreamT = TypeVar("_DefaultStreamT", bound=Union[Stream[Any], AsyncStream[Any]])


class BaseVertexClient(BaseClient[_HttpxClientT, _DefaultStreamT]):
    @typed_cached_property
    def region(self) -> str:
        raise RuntimeError("region not set")

    @typed_cached_property
    def project_id(self) -> str | None:
        project_id = os.environ.get("ANTHROPIC_VERTEX_PROJECT_ID")
        if project_id:
            return project_id

        return None

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

        if response.status_code == 504:
            return _exceptions.DeadlineExceededError(err_msg, response=response, body=body)

        if response.status_code >= 500:
            return _exceptions.InternalServerError(err_msg, response=response, body=body)
        return APIStatusError(err_msg, response=response, body=body)


class AnthropicVertex(BaseVertexClient[httpx.Client, Stream[Any]], SyncAPIClient):
    messages: Messages
    beta: Beta

    def __init__(
        self,
        *,
        region: str | NotGiven = NOT_GIVEN,
        project_id: str | NotGiven = NOT_GIVEN,
        access_token: str | None = None,
        credentials: GoogleCredentials | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        # Configure a custom httpx client. See the [httpx documentation](https://www.python-httpx.org/api/#client) for more details.
        http_client: httpx.Client | None = None,
        _strict_response_validation: bool = False,
    ) -> None:
        if not is_given(region):
            region = os.environ.get("CLOUD_ML_REGION", NOT_GIVEN)
        if not is_given(region):
            raise ValueError(
                "No region was given. The client should be instantiated with the `region` argument or the `CLOUD_ML_REGION` environment variable should be set."
            )

        if base_url is None:
            base_url = os.environ.get("ANTHROPIC_VERTEX_BASE_URL")
            if base_url is None:
                if region == "global":
                    base_url = "https://aiplatform.googleapis.com/v1"
                elif region == "us":
                    base_url = "https://aiplatform.us.rep.googleapis.com/v1"
                elif region == "eu":
                    base_url = "https://aiplatform.eu.rep.googleapis.com/v1"
                else:
                    base_url = f"https://{region}-aiplatform.googleapis.com/v1"

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

        if is_given(project_id):
            self.project_id = project_id

        self.region = region
        self.access_token = access_token
        self.credentials = credentials

        self.messages = Messages(self)
        self.beta = Beta(self)

    @override
    def _prepare_options(self, options: FinalRequestOptions) -> FinalRequestOptions:
        return _prepare_options(options, project_id=self.project_id, region=self.region)

    @override
    def _prepare_request(self, request: httpx.Request) -> None:
        if request.headers.get("Authorization"):
            # already authenticated, nothing for us to do
            return

        request.headers["Authorization"] = f"Bearer {self._ensure_access_token()}"

    def _ensure_access_token(self) -> str:
        if self.access_token is not None:
            return self.access_token

        if not self.credentials:
            self.credentials, project_id = load_auth(project_id=self.project_id)
            if not self.project_id:
                self.project_id = project_id

        if self.credentials.expired or not self.credentials.token:
            refresh_auth(self.credentials)

        if not self.credentials.token:
            raise RuntimeError("Could not resolve API token from the environment")

        assert isinstance(self.credentials.token, str)
        return self.credentials.token

    def copy(
        self,
        *,
        region: str | NotGiven = NOT_GIVEN,
        project_id: str | NotGiven = NOT_GIVEN,
        access_token: str | None = None,
        credentials: GoogleCredentials | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
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

        http_client = http_client or self._client

        return self.__class__(
            region=region if is_given(region) else self.region,
            project_id=project_id if is_given(project_id) else self.project_id or NOT_GIVEN,
            access_token=access_token or self.access_token,
            credentials=credentials or self.credentials,
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


class AsyncAnthropicVertex(BaseVertexClient[httpx.AsyncClient, AsyncStream[Any]], AsyncAPIClient):
    messages: AsyncMessages
    beta: AsyncBeta

    def __init__(
        self,
        *,
        region: str | NotGiven = NOT_GIVEN,
        project_id: str | NotGiven = NOT_GIVEN,
        access_token: str | None = None,
        credentials: GoogleCredentials | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        # Configure a custom httpx client. See the [httpx documentation](https://www.python-httpx.org/api/#client) for more details.
        http_client: httpx.AsyncClient | None = None,
        _strict_response_validation: bool = False,
    ) -> None:
        if not is_given(region):
            region = os.environ.get("CLOUD_ML_REGION", NOT_GIVEN)
        if not is_given(region):
            raise ValueError(
                "No region was given. The client should be instantiated with the `region` argument or the `CLOUD_ML_REGION` environment variable should be set."
            )

        if base_url is None:
            base_url = os.environ.get("ANTHROPIC_VERTEX_BASE_URL")
            if base_url is None:
                if region == "global":
                    base_url = "https://aiplatform.googleapis.com/v1"
                else:
                    base_url = f"https://{region}-aiplatform.googleapis.com/v1"

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

        if is_given(project_id):
            self.project_id = project_id

        self.region = region
        self.access_token = access_token
        self.credentials = credentials

        self.messages = AsyncMessages(self)
        self.beta = AsyncBeta(self)

    @override
    async def _prepare_options(self, options: FinalRequestOptions) -> FinalRequestOptions:
        return _prepare_options(options, project_id=self.project_id, region=self.region)

    @override
    async def _prepare_request(self, request: httpx.Request) -> None:
        if request.headers.get("Authorization"):
            # already authenticated, nothing for us to do
            return

        request.headers["Authorization"] = f"Bearer {await self._ensure_access_token()}"

    async def _ensure_access_token(self) -> str:
        if self.access_token is not None:
            return self.access_token

        if not self.credentials:
            self.credentials, project_id = await asyncify(load_auth)(project_id=self.project_id)
            if not self.project_id:
                self.project_id = project_id

        if self.credentials.expired or not self.credentials.token:
            await asyncify(refresh_auth)(self.credentials)

        if not self.credentials.token:
            raise RuntimeError("Could not resolve API token from the environment")

        assert isinstance(self.credentials.token, str)
        return self.credentials.token

    def copy(
        self,
        *,
        region: str | NotGiven = NOT_GIVEN,
        project_id: str | NotGiven = NOT_GIVEN,
        access_token: str | None = None,
        credentials: GoogleCredentials | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
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

        http_client = http_client or self._client

        return self.__class__(
            region=region if is_given(region) else self.region,
            project_id=project_id if is_given(project_id) else self.project_id or NOT_GIVEN,
            access_token=access_token or self.access_token,
            credentials=credentials or self.credentials,
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


def _prepare_options(input_options: FinalRequestOptions, *, project_id: str | None, region: str) -> FinalRequestOptions:
    options = model_copy(input_options, deep=True)

    if is_dict(options.json_data):
        options.json_data.setdefault("anthropic_version", DEFAULT_VERSION)

    if options.url in {"/v1/messages", "/v1/messages?beta=true"} and options.method == "post":
        if project_id is None:
            raise RuntimeError(
                "No project_id was given and it could not be resolved from credentials. The client should be instantiated with the `project_id` argument or the `ANTHROPIC_VERTEX_PROJECT_ID` environment variable should be set."
            )

        if not is_dict(options.json_data):
            raise RuntimeError("Expected json data to be a dictionary for post /v1/messages")

        model = options.json_data.pop("model")
        stream = options.json_data.get("stream", False)
        specifier = "streamRawPredict" if stream else "rawPredict"

        options.url = f"/projects/{project_id}/locations/{region}/publishers/anthropic/models/{model}:{specifier}"

    if options.url in {"/v1/messages/count_tokens", "/v1/messages/count_tokens?beta=true"} and options.method == "post":
        if project_id is None:
            raise RuntimeError(
                "No project_id was given and it could not be resolved from credentials. The client should be instantiated with the `project_id` argument or the `ANTHROPIC_VERTEX_PROJECT_ID` environment variable should be set."
            )

        options.url = f"/projects/{project_id}/locations/{region}/publishers/anthropic/models/count-tokens:rawPredict"

    if options.url.startswith("/v1/messages/batches"):
        raise AnthropicError("The Batch API is not supported in the Vertex client yet")

    return options
