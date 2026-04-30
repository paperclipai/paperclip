# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Mapping
from typing_extensions import Self, override

import httpx

from . import _exceptions
from ._qs import Querystring
from ._types import (
    Body,
    Omit,
    Query,
    Headers,
    Timeout,
    NotGiven,
    Transport,
    ProxiesTypes,
    RequestOptions,
    not_given,
)
from ._utils import is_given, get_async_library
from ._compat import cached_property
from ._version import __version__
from ._response import (
    to_raw_response_wrapper,
    to_streamed_response_wrapper,
    async_to_raw_response_wrapper,
    async_to_streamed_response_wrapper,
)
from ._streaming import Stream as Stream, AsyncStream as AsyncStream
from ._exceptions import APIStatusError
from ._base_client import (
    DEFAULT_MAX_RETRIES,
    SyncAPIClient,
    AsyncAPIClient,
    make_request_options,
)
from .types.get_status_response import GetStatusResponse

if TYPE_CHECKING:
    from .resources import (
        stt,
        tts,
        agents,
        voices,
        datasets,
        fine_tunes,
        access_token,
        voice_changer,
        pronunciation_dicts,
    )
    from .resources.stt import SttResource, AsyncSttResource
    from .resources.tts import TTSResource, AsyncTTSResource
    from .resources.voices import VoicesResource, AsyncVoicesResource
    from .resources.fine_tunes import FineTunesResource, AsyncFineTunesResource
    from .resources.access_token import AccessTokenResource, AsyncAccessTokenResource
    from .resources.agents.agents import AgentsResource, AsyncAgentsResource
    from .resources.voice_changer import VoiceChangerResource, AsyncVoiceChangerResource
    from .resources.datasets.datasets import DatasetsResource, AsyncDatasetsResource
    from .resources.pronunciation_dicts import PronunciationDictsResource, AsyncPronunciationDictsResource

__all__ = [
    "Timeout",
    "Transport",
    "ProxiesTypes",
    "RequestOptions",
    "Cartesia",
    "AsyncCartesia",
    "Client",
    "AsyncClient",
]


class Cartesia(SyncAPIClient):
    # client options
    api_key: str | None
    token: str | None

    websocket_base_url: str | httpx.URL | None
    """Base URL for WebSocket connections.

    If not specified, the default base URL will be used, with 'wss://' replacing the
    'http://' or 'https://' scheme. For example: 'http://example.com' becomes
    'wss://example.com'
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        token: str | None = None,
        base_url: str | httpx.URL | None = None,
        websocket_base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = not_given,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        # Configure a custom httpx client.
        # We provide a `DefaultHttpxClient` class that you can pass to retain the default values we use for `limits`, `timeout` & `follow_redirects`.
        # See the [httpx documentation](https://www.python-httpx.org/api/#client) for more details.
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
        """Construct a new synchronous Cartesia client instance."""
        self.api_key = api_key

        self.token = token

        self.websocket_base_url = websocket_base_url

        if base_url is None:
            base_url = os.environ.get("CARTESIA_BASE_URL")
        if base_url is None:
            base_url = f"https://api.cartesia.ai"

        super().__init__(
            version=__version__,
            base_url=base_url,
            max_retries=max_retries,
            timeout=timeout,
            http_client=http_client,
            custom_headers=default_headers,
            custom_query=default_query,
            _strict_response_validation=_strict_response_validation,
        )

    @cached_property
    def agents(self) -> AgentsResource:
        from .resources.agents import AgentsResource

        return AgentsResource(self)

    @cached_property
    def access_token(self) -> AccessTokenResource:
        from .resources.access_token import AccessTokenResource

        return AccessTokenResource(self)

    @cached_property
    def datasets(self) -> DatasetsResource:
        from .resources.datasets import DatasetsResource

        return DatasetsResource(self)

    @cached_property
    def fine_tunes(self) -> FineTunesResource:
        from .resources.fine_tunes import FineTunesResource

        return FineTunesResource(self)

    @cached_property
    def pronunciation_dicts(self) -> PronunciationDictsResource:
        from .resources.pronunciation_dicts import PronunciationDictsResource

        return PronunciationDictsResource(self)

    @cached_property
    def stt(self) -> SttResource:
        from .resources.stt import SttResource

        return SttResource(self)

    @cached_property
    def tts(self) -> TTSResource:
        from .resources.tts import TTSResource

        return TTSResource(self)

    @cached_property
    def voice_changer(self) -> VoiceChangerResource:
        from .resources.voice_changer import VoiceChangerResource

        return VoiceChangerResource(self)

    @cached_property
    def voices(self) -> VoicesResource:
        from .resources.voices import VoicesResource

        return VoicesResource(self)

    @cached_property
    def with_raw_response(self) -> CartesiaWithRawResponse:
        return CartesiaWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> CartesiaWithStreamedResponse:
        return CartesiaWithStreamedResponse(self)

    @property
    @override
    def qs(self) -> Querystring:
        return Querystring(array_format="brackets")

    @property
    @override
    def auth_headers(self) -> dict[str, str]:
        return {**self._token_auth, **self._api_key_auth}

    @property
    def _token_auth(self) -> dict[str, str]:
        token = self.token
        if token is None:
            return {}
        return {"Authorization": f"Bearer {token}"}

    @property
    def _api_key_auth(self) -> dict[str, str]:
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
            "cartesia-version": "2025-11-04",
            **self._custom_headers,
        }

    @override
    def _validate_headers(self, headers: Headers, custom_headers: Headers) -> None:
        if headers.get("Authorization") or isinstance(custom_headers.get("Authorization"), Omit):
            return

        raise TypeError(
            '"Could not resolve authentication method. Expected either token or api_key to be set. Or for one of the `Authorization` or `Authorization` headers to be explicitly omitted"'
        )

    def copy(
        self,
        *,
        api_key: str | None = None,
        token: str | None = None,
        websocket_base_url: str | httpx.URL | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = not_given,
        http_client: httpx.Client | None = None,
        max_retries: int | NotGiven = not_given,
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
            api_key=api_key or self.api_key,
            token=token or self.token,
            websocket_base_url=websocket_base_url or self.websocket_base_url,
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

    def get_status(
        self,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> GetStatusResponse:
        """API Status and Version"""
        return self.get(
            "/",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=GetStatusResponse,
        )

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

        if response.status_code >= 500:
            return _exceptions.InternalServerError(err_msg, response=response, body=body)
        return APIStatusError(err_msg, response=response, body=body)


class AsyncCartesia(AsyncAPIClient):
    # client options
    api_key: str | None
    token: str | None

    websocket_base_url: str | httpx.URL | None
    """Base URL for WebSocket connections.

    If not specified, the default base URL will be used, with 'wss://' replacing the
    'http://' or 'https://' scheme. For example: 'http://example.com' becomes
    'wss://example.com'
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        token: str | None = None,
        base_url: str | httpx.URL | None = None,
        websocket_base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = not_given,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        default_query: Mapping[str, object] | None = None,
        # Configure a custom httpx client.
        # We provide a `DefaultAsyncHttpxClient` class that you can pass to retain the default values we use for `limits`, `timeout` & `follow_redirects`.
        # See the [httpx documentation](https://www.python-httpx.org/api/#asyncclient) for more details.
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
        """Construct a new async AsyncCartesia client instance."""
        self.api_key = api_key

        self.token = token

        self.websocket_base_url = websocket_base_url

        if base_url is None:
            base_url = os.environ.get("CARTESIA_BASE_URL")
        if base_url is None:
            base_url = f"https://api.cartesia.ai"

        super().__init__(
            version=__version__,
            base_url=base_url,
            max_retries=max_retries,
            timeout=timeout,
            http_client=http_client,
            custom_headers=default_headers,
            custom_query=default_query,
            _strict_response_validation=_strict_response_validation,
        )

    @cached_property
    def agents(self) -> AsyncAgentsResource:
        from .resources.agents import AsyncAgentsResource

        return AsyncAgentsResource(self)

    @cached_property
    def access_token(self) -> AsyncAccessTokenResource:
        from .resources.access_token import AsyncAccessTokenResource

        return AsyncAccessTokenResource(self)

    @cached_property
    def datasets(self) -> AsyncDatasetsResource:
        from .resources.datasets import AsyncDatasetsResource

        return AsyncDatasetsResource(self)

    @cached_property
    def fine_tunes(self) -> AsyncFineTunesResource:
        from .resources.fine_tunes import AsyncFineTunesResource

        return AsyncFineTunesResource(self)

    @cached_property
    def pronunciation_dicts(self) -> AsyncPronunciationDictsResource:
        from .resources.pronunciation_dicts import AsyncPronunciationDictsResource

        return AsyncPronunciationDictsResource(self)

    @cached_property
    def stt(self) -> AsyncSttResource:
        from .resources.stt import AsyncSttResource

        return AsyncSttResource(self)

    @cached_property
    def tts(self) -> AsyncTTSResource:
        from .resources.tts import AsyncTTSResource

        return AsyncTTSResource(self)

    @cached_property
    def voice_changer(self) -> AsyncVoiceChangerResource:
        from .resources.voice_changer import AsyncVoiceChangerResource

        return AsyncVoiceChangerResource(self)

    @cached_property
    def voices(self) -> AsyncVoicesResource:
        from .resources.voices import AsyncVoicesResource

        return AsyncVoicesResource(self)

    @cached_property
    def with_raw_response(self) -> AsyncCartesiaWithRawResponse:
        return AsyncCartesiaWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncCartesiaWithStreamedResponse:
        return AsyncCartesiaWithStreamedResponse(self)

    @property
    @override
    def qs(self) -> Querystring:
        return Querystring(array_format="brackets")

    @property
    @override
    def auth_headers(self) -> dict[str, str]:
        return {**self._token_auth, **self._api_key_auth}

    @property
    def _token_auth(self) -> dict[str, str]:
        token = self.token
        if token is None:
            return {}
        return {"Authorization": f"Bearer {token}"}

    @property
    def _api_key_auth(self) -> dict[str, str]:
        api_key = self.api_key
        if api_key is None:
            return {}
        return {"Authorization": f"Bearer {api_key}"}

    @property
    @override
    def default_headers(self) -> dict[str, str | Omit]:
        return {
            **super().default_headers,
            "X-Stainless-Async": f"async:{get_async_library()}",
            "cartesia-version": "2025-11-04",
            **self._custom_headers,
        }

    @override
    def _validate_headers(self, headers: Headers, custom_headers: Headers) -> None:
        if headers.get("Authorization") or isinstance(custom_headers.get("Authorization"), Omit):
            return

        raise TypeError(
            '"Could not resolve authentication method. Expected either token or api_key to be set. Or for one of the `Authorization` or `Authorization` headers to be explicitly omitted"'
        )

    def copy(
        self,
        *,
        api_key: str | None = None,
        token: str | None = None,
        websocket_base_url: str | httpx.URL | None = None,
        base_url: str | httpx.URL | None = None,
        timeout: float | Timeout | None | NotGiven = not_given,
        http_client: httpx.AsyncClient | None = None,
        max_retries: int | NotGiven = not_given,
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
            api_key=api_key or self.api_key,
            token=token or self.token,
            websocket_base_url=websocket_base_url or self.websocket_base_url,
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

    async def get_status(
        self,
        *,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> GetStatusResponse:
        """API Status and Version"""
        return await self.get(
            "/",
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=GetStatusResponse,
        )

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

        if response.status_code >= 500:
            return _exceptions.InternalServerError(err_msg, response=response, body=body)
        return APIStatusError(err_msg, response=response, body=body)


class CartesiaWithRawResponse:
    _client: Cartesia

    def __init__(self, client: Cartesia) -> None:
        self._client = client

        self.get_status = to_raw_response_wrapper(
            client.get_status,
        )

    @cached_property
    def agents(self) -> agents.AgentsResourceWithRawResponse:
        from .resources.agents import AgentsResourceWithRawResponse

        return AgentsResourceWithRawResponse(self._client.agents)

    @cached_property
    def access_token(self) -> access_token.AccessTokenResourceWithRawResponse:
        from .resources.access_token import AccessTokenResourceWithRawResponse

        return AccessTokenResourceWithRawResponse(self._client.access_token)

    @cached_property
    def datasets(self) -> datasets.DatasetsResourceWithRawResponse:
        from .resources.datasets import DatasetsResourceWithRawResponse

        return DatasetsResourceWithRawResponse(self._client.datasets)

    @cached_property
    def fine_tunes(self) -> fine_tunes.FineTunesResourceWithRawResponse:
        from .resources.fine_tunes import FineTunesResourceWithRawResponse

        return FineTunesResourceWithRawResponse(self._client.fine_tunes)

    @cached_property
    def pronunciation_dicts(self) -> pronunciation_dicts.PronunciationDictsResourceWithRawResponse:
        from .resources.pronunciation_dicts import PronunciationDictsResourceWithRawResponse

        return PronunciationDictsResourceWithRawResponse(self._client.pronunciation_dicts)

    @cached_property
    def stt(self) -> stt.SttResourceWithRawResponse:
        from .resources.stt import SttResourceWithRawResponse

        return SttResourceWithRawResponse(self._client.stt)

    @cached_property
    def tts(self) -> tts.TTSResourceWithRawResponse:
        from .resources.tts import TTSResourceWithRawResponse

        return TTSResourceWithRawResponse(self._client.tts)

    @cached_property
    def voice_changer(self) -> voice_changer.VoiceChangerResourceWithRawResponse:
        from .resources.voice_changer import VoiceChangerResourceWithRawResponse

        return VoiceChangerResourceWithRawResponse(self._client.voice_changer)

    @cached_property
    def voices(self) -> voices.VoicesResourceWithRawResponse:
        from .resources.voices import VoicesResourceWithRawResponse

        return VoicesResourceWithRawResponse(self._client.voices)


class AsyncCartesiaWithRawResponse:
    _client: AsyncCartesia

    def __init__(self, client: AsyncCartesia) -> None:
        self._client = client

        self.get_status = async_to_raw_response_wrapper(
            client.get_status,
        )

    @cached_property
    def agents(self) -> agents.AsyncAgentsResourceWithRawResponse:
        from .resources.agents import AsyncAgentsResourceWithRawResponse

        return AsyncAgentsResourceWithRawResponse(self._client.agents)

    @cached_property
    def access_token(self) -> access_token.AsyncAccessTokenResourceWithRawResponse:
        from .resources.access_token import AsyncAccessTokenResourceWithRawResponse

        return AsyncAccessTokenResourceWithRawResponse(self._client.access_token)

    @cached_property
    def datasets(self) -> datasets.AsyncDatasetsResourceWithRawResponse:
        from .resources.datasets import AsyncDatasetsResourceWithRawResponse

        return AsyncDatasetsResourceWithRawResponse(self._client.datasets)

    @cached_property
    def fine_tunes(self) -> fine_tunes.AsyncFineTunesResourceWithRawResponse:
        from .resources.fine_tunes import AsyncFineTunesResourceWithRawResponse

        return AsyncFineTunesResourceWithRawResponse(self._client.fine_tunes)

    @cached_property
    def pronunciation_dicts(self) -> pronunciation_dicts.AsyncPronunciationDictsResourceWithRawResponse:
        from .resources.pronunciation_dicts import AsyncPronunciationDictsResourceWithRawResponse

        return AsyncPronunciationDictsResourceWithRawResponse(self._client.pronunciation_dicts)

    @cached_property
    def stt(self) -> stt.AsyncSttResourceWithRawResponse:
        from .resources.stt import AsyncSttResourceWithRawResponse

        return AsyncSttResourceWithRawResponse(self._client.stt)

    @cached_property
    def tts(self) -> tts.AsyncTTSResourceWithRawResponse:
        from .resources.tts import AsyncTTSResourceWithRawResponse

        return AsyncTTSResourceWithRawResponse(self._client.tts)

    @cached_property
    def voice_changer(self) -> voice_changer.AsyncVoiceChangerResourceWithRawResponse:
        from .resources.voice_changer import AsyncVoiceChangerResourceWithRawResponse

        return AsyncVoiceChangerResourceWithRawResponse(self._client.voice_changer)

    @cached_property
    def voices(self) -> voices.AsyncVoicesResourceWithRawResponse:
        from .resources.voices import AsyncVoicesResourceWithRawResponse

        return AsyncVoicesResourceWithRawResponse(self._client.voices)


class CartesiaWithStreamedResponse:
    _client: Cartesia

    def __init__(self, client: Cartesia) -> None:
        self._client = client

        self.get_status = to_streamed_response_wrapper(
            client.get_status,
        )

    @cached_property
    def agents(self) -> agents.AgentsResourceWithStreamingResponse:
        from .resources.agents import AgentsResourceWithStreamingResponse

        return AgentsResourceWithStreamingResponse(self._client.agents)

    @cached_property
    def access_token(self) -> access_token.AccessTokenResourceWithStreamingResponse:
        from .resources.access_token import AccessTokenResourceWithStreamingResponse

        return AccessTokenResourceWithStreamingResponse(self._client.access_token)

    @cached_property
    def datasets(self) -> datasets.DatasetsResourceWithStreamingResponse:
        from .resources.datasets import DatasetsResourceWithStreamingResponse

        return DatasetsResourceWithStreamingResponse(self._client.datasets)

    @cached_property
    def fine_tunes(self) -> fine_tunes.FineTunesResourceWithStreamingResponse:
        from .resources.fine_tunes import FineTunesResourceWithStreamingResponse

        return FineTunesResourceWithStreamingResponse(self._client.fine_tunes)

    @cached_property
    def pronunciation_dicts(self) -> pronunciation_dicts.PronunciationDictsResourceWithStreamingResponse:
        from .resources.pronunciation_dicts import PronunciationDictsResourceWithStreamingResponse

        return PronunciationDictsResourceWithStreamingResponse(self._client.pronunciation_dicts)

    @cached_property
    def stt(self) -> stt.SttResourceWithStreamingResponse:
        from .resources.stt import SttResourceWithStreamingResponse

        return SttResourceWithStreamingResponse(self._client.stt)

    @cached_property
    def tts(self) -> tts.TTSResourceWithStreamingResponse:
        from .resources.tts import TTSResourceWithStreamingResponse

        return TTSResourceWithStreamingResponse(self._client.tts)

    @cached_property
    def voice_changer(self) -> voice_changer.VoiceChangerResourceWithStreamingResponse:
        from .resources.voice_changer import VoiceChangerResourceWithStreamingResponse

        return VoiceChangerResourceWithStreamingResponse(self._client.voice_changer)

    @cached_property
    def voices(self) -> voices.VoicesResourceWithStreamingResponse:
        from .resources.voices import VoicesResourceWithStreamingResponse

        return VoicesResourceWithStreamingResponse(self._client.voices)


class AsyncCartesiaWithStreamedResponse:
    _client: AsyncCartesia

    def __init__(self, client: AsyncCartesia) -> None:
        self._client = client

        self.get_status = async_to_streamed_response_wrapper(
            client.get_status,
        )

    @cached_property
    def agents(self) -> agents.AsyncAgentsResourceWithStreamingResponse:
        from .resources.agents import AsyncAgentsResourceWithStreamingResponse

        return AsyncAgentsResourceWithStreamingResponse(self._client.agents)

    @cached_property
    def access_token(self) -> access_token.AsyncAccessTokenResourceWithStreamingResponse:
        from .resources.access_token import AsyncAccessTokenResourceWithStreamingResponse

        return AsyncAccessTokenResourceWithStreamingResponse(self._client.access_token)

    @cached_property
    def datasets(self) -> datasets.AsyncDatasetsResourceWithStreamingResponse:
        from .resources.datasets import AsyncDatasetsResourceWithStreamingResponse

        return AsyncDatasetsResourceWithStreamingResponse(self._client.datasets)

    @cached_property
    def fine_tunes(self) -> fine_tunes.AsyncFineTunesResourceWithStreamingResponse:
        from .resources.fine_tunes import AsyncFineTunesResourceWithStreamingResponse

        return AsyncFineTunesResourceWithStreamingResponse(self._client.fine_tunes)

    @cached_property
    def pronunciation_dicts(self) -> pronunciation_dicts.AsyncPronunciationDictsResourceWithStreamingResponse:
        from .resources.pronunciation_dicts import AsyncPronunciationDictsResourceWithStreamingResponse

        return AsyncPronunciationDictsResourceWithStreamingResponse(self._client.pronunciation_dicts)

    @cached_property
    def stt(self) -> stt.AsyncSttResourceWithStreamingResponse:
        from .resources.stt import AsyncSttResourceWithStreamingResponse

        return AsyncSttResourceWithStreamingResponse(self._client.stt)

    @cached_property
    def tts(self) -> tts.AsyncTTSResourceWithStreamingResponse:
        from .resources.tts import AsyncTTSResourceWithStreamingResponse

        return AsyncTTSResourceWithStreamingResponse(self._client.tts)

    @cached_property
    def voice_changer(self) -> voice_changer.AsyncVoiceChangerResourceWithStreamingResponse:
        from .resources.voice_changer import AsyncVoiceChangerResourceWithStreamingResponse

        return AsyncVoiceChangerResourceWithStreamingResponse(self._client.voice_changer)

    @cached_property
    def voices(self) -> voices.AsyncVoicesResourceWithStreamingResponse:
        from .resources.voices import AsyncVoicesResourceWithStreamingResponse

        return AsyncVoicesResourceWithStreamingResponse(self._client.voices)


Client = Cartesia

AsyncClient = AsyncCartesia
