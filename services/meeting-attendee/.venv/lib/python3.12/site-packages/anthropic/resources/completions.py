# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List
from typing_extensions import Literal, overload

import httpx

from .. import _legacy_response
from ..types import completion_create_params
from .._types import Body, Omit, Query, Headers, NotGiven, SequenceNotStr, omit, not_given
from .._utils import is_given, required_args, maybe_transform, strip_not_given, async_maybe_transform
from .._compat import cached_property
from .._resource import SyncAPIResource, AsyncAPIResource
from .._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from .._constants import DEFAULT_TIMEOUT
from .._streaming import Stream, AsyncStream
from .._base_client import make_request_options
from ..types.completion import Completion
from ..types.model_param import ModelParam
from ..types.metadata_param import MetadataParam
from ..types.anthropic_beta_param import AnthropicBetaParam

__all__ = ["Completions", "AsyncCompletions"]


class Completions(SyncAPIResource):
    @cached_property
    def with_raw_response(self) -> CompletionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return CompletionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> CompletionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return CompletionsWithStreamingResponse(self)

    @overload
    def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Completion:
        """[Legacy] Create a Text Completion.

        The Text Completions API is a legacy API.

        We recommend using the
        [Messages API](https://docs.claude.com/en/api/messages) going forward.

        Future models and features will not be compatible with Text Completions. See our
        [migration guide](https://docs.claude.com/en/api/migrating-from-text-completions-to-messages)
        for guidance in migrating from Text Completions to Messages.

        Args:
          max_tokens_to_sample: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          prompt: The prompt that you want Claude to complete.

              For proper response generation you will need to format your prompt using
              alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

              ```
              "\n\nHuman: {userQuestion}\n\nAssistant:"
              ```

              See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
              our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
              for more details.

          metadata: An object describing metadata about the request.

          stop_sequences: Sequences that will cause the model to stop generating.

              Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
              sequences in the future. By providing the stop_sequences parameter, you may
              include additional strings that will cause the model to stop generating.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/streaming) for details.

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @overload
    def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        stream: Literal[True],
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Stream[Completion]:
        """[Legacy] Create a Text Completion.

        The Text Completions API is a legacy API.

        We recommend using the
        [Messages API](https://docs.claude.com/en/api/messages) going forward.

        Future models and features will not be compatible with Text Completions. See our
        [migration guide](https://docs.claude.com/en/api/migrating-from-text-completions-to-messages)
        for guidance in migrating from Text Completions to Messages.

        Args:
          max_tokens_to_sample: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          prompt: The prompt that you want Claude to complete.

              For proper response generation you will need to format your prompt using
              alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

              ```
              "\n\nHuman: {userQuestion}\n\nAssistant:"
              ```

              See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
              our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
              for more details.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/streaming) for details.

          metadata: An object describing metadata about the request.

          stop_sequences: Sequences that will cause the model to stop generating.

              Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
              sequences in the future. By providing the stop_sequences parameter, you may
              include additional strings that will cause the model to stop generating.

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @overload
    def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        stream: bool,
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Completion | Stream[Completion]:
        """[Legacy] Create a Text Completion.

        The Text Completions API is a legacy API.

        We recommend using the
        [Messages API](https://docs.claude.com/en/api/messages) going forward.

        Future models and features will not be compatible with Text Completions. See our
        [migration guide](https://docs.claude.com/en/api/migrating-from-text-completions-to-messages)
        for guidance in migrating from Text Completions to Messages.

        Args:
          max_tokens_to_sample: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          prompt: The prompt that you want Claude to complete.

              For proper response generation you will need to format your prompt using
              alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

              ```
              "\n\nHuman: {userQuestion}\n\nAssistant:"
              ```

              See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
              our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
              for more details.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/streaming) for details.

          metadata: An object describing metadata about the request.

          stop_sequences: Sequences that will cause the model to stop generating.

              Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
              sequences in the future. By providing the stop_sequences parameter, you may
              include additional strings that will cause the model to stop generating.

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @required_args(["max_tokens_to_sample", "model", "prompt"], ["max_tokens_to_sample", "model", "prompt", "stream"])
    def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Completion | Stream[Completion]:
        if not is_given(timeout) and self._client.timeout == DEFAULT_TIMEOUT:
            timeout = 600
        extra_headers = {
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else not_given}),
            **(extra_headers or {}),
        }
        return self._post(
            "/v1/complete",
            body=maybe_transform(
                {
                    "max_tokens_to_sample": max_tokens_to_sample,
                    "model": model,
                    "prompt": prompt,
                    "metadata": metadata,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "temperature": temperature,
                    "top_k": top_k,
                    "top_p": top_p,
                },
                completion_create_params.CompletionCreateParamsStreaming
                if stream
                else completion_create_params.CompletionCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Completion,
            stream=stream or False,
            stream_cls=Stream[Completion],
        )


class AsyncCompletions(AsyncAPIResource):
    @cached_property
    def with_raw_response(self) -> AsyncCompletionsWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncCompletionsWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncCompletionsWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncCompletionsWithStreamingResponse(self)

    @overload
    async def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Completion:
        """[Legacy] Create a Text Completion.

        The Text Completions API is a legacy API.

        We recommend using the
        [Messages API](https://docs.claude.com/en/api/messages) going forward.

        Future models and features will not be compatible with Text Completions. See our
        [migration guide](https://docs.claude.com/en/api/migrating-from-text-completions-to-messages)
        for guidance in migrating from Text Completions to Messages.

        Args:
          max_tokens_to_sample: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          prompt: The prompt that you want Claude to complete.

              For proper response generation you will need to format your prompt using
              alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

              ```
              "\n\nHuman: {userQuestion}\n\nAssistant:"
              ```

              See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
              our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
              for more details.

          metadata: An object describing metadata about the request.

          stop_sequences: Sequences that will cause the model to stop generating.

              Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
              sequences in the future. By providing the stop_sequences parameter, you may
              include additional strings that will cause the model to stop generating.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/streaming) for details.

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @overload
    async def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        stream: Literal[True],
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncStream[Completion]:
        """[Legacy] Create a Text Completion.

        The Text Completions API is a legacy API.

        We recommend using the
        [Messages API](https://docs.claude.com/en/api/messages) going forward.

        Future models and features will not be compatible with Text Completions. See our
        [migration guide](https://docs.claude.com/en/api/migrating-from-text-completions-to-messages)
        for guidance in migrating from Text Completions to Messages.

        Args:
          max_tokens_to_sample: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          prompt: The prompt that you want Claude to complete.

              For proper response generation you will need to format your prompt using
              alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

              ```
              "\n\nHuman: {userQuestion}\n\nAssistant:"
              ```

              See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
              our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
              for more details.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/streaming) for details.

          metadata: An object describing metadata about the request.

          stop_sequences: Sequences that will cause the model to stop generating.

              Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
              sequences in the future. By providing the stop_sequences parameter, you may
              include additional strings that will cause the model to stop generating.

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @overload
    async def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        stream: bool,
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Completion | AsyncStream[Completion]:
        """[Legacy] Create a Text Completion.

        The Text Completions API is a legacy API.

        We recommend using the
        [Messages API](https://docs.claude.com/en/api/messages) going forward.

        Future models and features will not be compatible with Text Completions. See our
        [migration guide](https://docs.claude.com/en/api/migrating-from-text-completions-to-messages)
        for guidance in migrating from Text Completions to Messages.

        Args:
          max_tokens_to_sample: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          prompt: The prompt that you want Claude to complete.

              For proper response generation you will need to format your prompt using
              alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

              ```
              "\n\nHuman: {userQuestion}\n\nAssistant:"
              ```

              See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
              our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
              for more details.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/streaming) for details.

          metadata: An object describing metadata about the request.

          stop_sequences: Sequences that will cause the model to stop generating.

              Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
              sequences in the future. By providing the stop_sequences parameter, you may
              include additional strings that will cause the model to stop generating.

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @required_args(["max_tokens_to_sample", "model", "prompt"], ["max_tokens_to_sample", "model", "prompt", "stream"])
    async def create(
        self,
        *,
        max_tokens_to_sample: int,
        model: ModelParam,
        prompt: str,
        metadata: MetadataParam | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Completion | AsyncStream[Completion]:
        if not is_given(timeout) and self._client.timeout == DEFAULT_TIMEOUT:
            timeout = 600
        extra_headers = {
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else not_given}),
            **(extra_headers or {}),
        }
        return await self._post(
            "/v1/complete",
            body=await async_maybe_transform(
                {
                    "max_tokens_to_sample": max_tokens_to_sample,
                    "model": model,
                    "prompt": prompt,
                    "metadata": metadata,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "temperature": temperature,
                    "top_k": top_k,
                    "top_p": top_p,
                },
                completion_create_params.CompletionCreateParamsStreaming
                if stream
                else completion_create_params.CompletionCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Completion,
            stream=stream or False,
            stream_cls=AsyncStream[Completion],
        )


class CompletionsWithRawResponse:
    def __init__(self, completions: Completions) -> None:
        self._completions = completions

        self.create = _legacy_response.to_raw_response_wrapper(
            completions.create,
        )


class AsyncCompletionsWithRawResponse:
    def __init__(self, completions: AsyncCompletions) -> None:
        self._completions = completions

        self.create = _legacy_response.async_to_raw_response_wrapper(
            completions.create,
        )


class CompletionsWithStreamingResponse:
    def __init__(self, completions: Completions) -> None:
        self._completions = completions

        self.create = to_streamed_response_wrapper(
            completions.create,
        )


class AsyncCompletionsWithStreamingResponse:
    def __init__(self, completions: AsyncCompletions) -> None:
        self._completions = completions

        self.create = async_to_streamed_response_wrapper(
            completions.create,
        )
