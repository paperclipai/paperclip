# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

import warnings
from typing import Type, Union, Iterable, Optional, cast
from functools import partial
from typing_extensions import Literal, overload

import httpx
import pydantic

from ... import _legacy_response
from ...types import (
    ThinkingConfigParam,
    message_create_params,
    message_count_tokens_params,
)
from .batches import (
    Batches,
    AsyncBatches,
    BatchesWithRawResponse,
    AsyncBatchesWithRawResponse,
    BatchesWithStreamingResponse,
    AsyncBatchesWithStreamingResponse,
)
from ..._types import NOT_GIVEN, Body, Omit, Query, Headers, NotGiven, SequenceNotStr, omit, not_given
from ..._utils import is_given, required_args, maybe_transform, async_maybe_transform
from ..._compat import cached_property
from ..._models import TypeAdapter
from ..._resource import SyncAPIResource, AsyncAPIResource
from ..._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ..._constants import DEFAULT_TIMEOUT, MODEL_NONSTREAMING_TOKENS
from ..._streaming import Stream, AsyncStream
from ..._base_client import make_request_options
from ..._utils._utils import is_dict
from ...lib.streaming import MessageStreamManager, AsyncMessageStreamManager
from ...types.message import Message
from ...types.model_param import ModelParam
from ...types.message_param import MessageParam
from ...lib._parse._response import ResponseFormatT, parse_response
from ...types.metadata_param import MetadataParam
from ...types.parsed_message import ParsedMessage
from ...lib._parse._transform import transform_schema
from ...types.text_block_param import TextBlockParam
from ...types.tool_union_param import ToolUnionParam
from ...types.tool_choice_param import ToolChoiceParam
from ...types.output_config_param import OutputConfigParam
from ...types.message_tokens_count import MessageTokensCount
from ...types.thinking_config_param import ThinkingConfigParam
from ...types.json_output_format_param import JSONOutputFormatParam
from ...types.raw_message_stream_event import RawMessageStreamEvent
from ...types.cache_control_ephemeral_param import CacheControlEphemeralParam
from ...types.message_count_tokens_tool_param import MessageCountTokensToolParam

__all__ = ["Messages", "AsyncMessages"]


DEPRECATED_MODELS = {
    "claude-1.3": "November 6th, 2024",
    "claude-1.3-100k": "November 6th, 2024",
    "claude-instant-1.1": "November 6th, 2024",
    "claude-instant-1.1-100k": "November 6th, 2024",
    "claude-instant-1.2": "November 6th, 2024",
    "claude-3-sonnet-20240229": "July 21st, 2025",
    "claude-3-opus-20240229": "January 5th, 2026",
    "claude-2.1": "July 21st, 2025",
    "claude-2.0": "July 21st, 2025",
    "claude-3-7-sonnet-latest": "February 19th, 2026",
    "claude-3-7-sonnet-20250219": "February 19th, 2026",
    "claude-3-5-haiku-latest": "February 19th, 2026",
    "claude-3-5-haiku-20241022": "February 19th, 2026",
    "claude-opus-4-0": "June 15th, 2026",
    "claude-opus-4-20250514": "June 15th, 2026",
    "claude-sonnet-4-0": "June 15th, 2026",
    "claude-sonnet-4-20250514": "June 15th, 2026",
}

MODELS_TO_WARN_WITH_THINKING_ENABLED = ["claude-opus-4-6", "claude-mythos-preview"]


class Messages(SyncAPIResource):
    @cached_property
    def batches(self) -> Batches:
        return Batches(self._client)

    @cached_property
    def with_raw_response(self) -> MessagesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return MessagesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> MessagesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return MessagesWithStreamingResponse(self)

    @overload
    def create(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Message:
        """
        Send a structured list of input messages with text and/or image content, and the
        model will generate the next message in the conversation.

        The Messages API can be used for either single queries or stateless multi-turn
        conversations.

        Learn more about the Messages API in our
        [user guide](https://docs.claude.com/en/docs/initial-setup)

        Args:
          max_tokens: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

              Different models have different maximum values for this parameter. See
              [models](https://docs.claude.com/en/docs/models-overview) for details.

          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          container: Container identifier for reuse across requests.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          stop_sequences: Custom text sequences that will cause the model to stop generating.

              Our models will normally stop when they have naturally completed their turn,
              which will result in a response `stop_reason` of `"end_turn"`.

              If you want the model to stop generating when it encounters custom strings of
              text, you can use the `stop_sequences` parameter. If the model encounters one of
              the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
              and the response `stop_sequence` value will contain the matched stop sequence.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.

          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

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
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        stream: Literal[True],
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Stream[RawMessageStreamEvent]:
        """
        Send a structured list of input messages with text and/or image content, and the
        model will generate the next message in the conversation.

        The Messages API can be used for either single queries or stateless multi-turn
        conversations.

        Learn more about the Messages API in our
        [user guide](https://docs.claude.com/en/docs/initial-setup)

        Args:
          max_tokens: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

              Different models have different maximum values for this parameter. See
              [models](https://docs.claude.com/en/docs/models-overview) for details.

          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          container: Container identifier for reuse across requests.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          stop_sequences: Custom text sequences that will cause the model to stop generating.

              Our models will normally stop when they have naturally completed their turn,
              which will result in a response `stop_reason` of `"end_turn"`.

              If you want the model to stop generating when it encounters custom strings of
              text, you can use the `stop_sequences` parameter. If the model encounters one of
              the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
              and the response `stop_sequence` value will contain the matched stop sequence.

          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

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
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        stream: bool,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Message | Stream[RawMessageStreamEvent]:
        """
        Send a structured list of input messages with text and/or image content, and the
        model will generate the next message in the conversation.

        The Messages API can be used for either single queries or stateless multi-turn
        conversations.

        Learn more about the Messages API in our
        [user guide](https://docs.claude.com/en/docs/initial-setup)

        Args:
          max_tokens: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

              Different models have different maximum values for this parameter. See
              [models](https://docs.claude.com/en/docs/models-overview) for details.

          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          container: Container identifier for reuse across requests.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          stop_sequences: Custom text sequences that will cause the model to stop generating.

              Our models will normally stop when they have naturally completed their turn,
              which will result in a response `stop_reason` of `"end_turn"`.

              If you want the model to stop generating when it encounters custom strings of
              text, you can use the `stop_sequences` parameter. If the model encounters one of
              the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
              and the response `stop_sequence` value will contain the matched stop sequence.

          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @required_args(["max_tokens", "messages", "model"], ["max_tokens", "messages", "model", "stream"])
    def create(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Message | Stream[RawMessageStreamEvent]:
        if not stream and not is_given(timeout) and self._client.timeout == DEFAULT_TIMEOUT:
            timeout = self._client._calculate_nonstreaming_timeout(
                max_tokens, MODEL_NONSTREAMING_TOKENS.get(model, None)
            )

        if model in DEPRECATED_MODELS:
            warnings.warn(
                f"The model '{model}' is deprecated and will reach end-of-life on {DEPRECATED_MODELS[model]}.\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.",
                DeprecationWarning,
                stacklevel=3,
            )

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        return self._post(
            "/v1/messages",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "container": container,
                    "inference_geo": inference_geo,
                    "metadata": metadata,
                    "output_config": output_config,
                    "service_tier": service_tier,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                },
                message_create_params.MessageCreateParamsStreaming
                if stream
                else message_create_params.MessageCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Message,
            stream=stream or False,
            stream_cls=Stream[RawMessageStreamEvent],
        )

    def stream(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        output_format: None | JSONOutputFormatParam | type[ResponseFormatT] | Omit = omit,
        container: Optional[str] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> MessageStreamManager[ResponseFormatT]:
        """Create a Message stream"""
        if model in DEPRECATED_MODELS:
            warnings.warn(
                f"The model '{model}' is deprecated and will reach end-of-life on {DEPRECATED_MODELS[model]}.\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.",
                DeprecationWarning,
                stacklevel=3,
            )

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        extra_headers = {
            "X-Stainless-Helper-Method": "stream",
            "X-Stainless-Stream-Helper": "messages",
            **(extra_headers or {}),
        }

        transformed_output_format: Optional[JSONOutputFormatParam] | NotGiven = NOT_GIVEN

        if is_dict(output_format):
            transformed_output_format = cast(JSONOutputFormatParam, output_format)
        elif is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = JSONOutputFormatParam(schema=transform_schema(schema), type="json_schema")
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        # Merge output_format into output_config
        merged_output_config: OutputConfigParam | Omit = omit
        if is_given(transformed_output_format):
            if is_given(output_config):
                merged_output_config = {**output_config, "format": transformed_output_format}
            else:
                merged_output_config = {"format": transformed_output_format}
        elif is_given(output_config):
            merged_output_config = output_config

        make_request = partial(
            self._post,
            "/v1/messages",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "inference_geo": inference_geo,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "container": container,
                    "service_tier": service_tier,
                    "stop_sequences": stop_sequences,
                    "system": system,
                    "temperature": temperature,
                    "top_k": top_k,
                    "top_p": top_p,
                    "tools": tools,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "stream": True,
                },
                message_create_params.MessageCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Message,
            stream=True,
            stream_cls=Stream[RawMessageStreamEvent],
        )
        return MessageStreamManager(
            make_request,
            output_format=NOT_GIVEN if is_dict(output_format) else cast(ResponseFormatT, output_format),
        )

    def parse(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> ParsedMessage[ResponseFormatT]:
        if not stream and not is_given(timeout) and self._client.timeout == DEFAULT_TIMEOUT:
            timeout = self._client._calculate_nonstreaming_timeout(
                max_tokens, MODEL_NONSTREAMING_TOKENS.get(model, None)
            )

        if model in DEPRECATED_MODELS:
            warnings.warn(
                f"The model '{model}' is deprecated and will reach end-of-life on {DEPRECATED_MODELS[model]}.\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.",
                DeprecationWarning,
                stacklevel=3,
            )

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        extra_headers = {
            "X-Stainless-Helper": "messages.parse",
            **(extra_headers or {}),
        }

        transformed_output_format: Optional[JSONOutputFormatParam] | NotGiven = NOT_GIVEN

        if is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = JSONOutputFormatParam(schema=transform_schema(schema), type="json_schema")
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        def parser(response: Message) -> ParsedMessage[ResponseFormatT]:
            return parse_response(
                response=response,
                output_format=cast(
                    ResponseFormatT,
                    output_format if is_given(output_format) and output_format is not None else NOT_GIVEN,
                ),
            )

        # Merge output_format into output_config
        merged_output_config: OutputConfigParam | Omit = omit
        if is_given(transformed_output_format):
            if is_given(output_config):
                merged_output_config = {**output_config, "format": transformed_output_format}
            else:
                merged_output_config = {"format": transformed_output_format}
        elif is_given(output_config):
            merged_output_config = output_config

        return self._post(
            "/v1/messages",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "service_tier": service_tier,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                },
                message_create_params.MessageCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                post_parser=parser,
            ),
            cast_to=cast(Type[ParsedMessage[ResponseFormatT]], Message),
            stream=False,
        )

    def count_tokens(
        self,
        *,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        output_format: None | JSONOutputFormatParam | type | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[MessageCountTokensToolParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MessageTokensCount:
        """
        Count the number of tokens in a Message.

        The Token Count API can be used to count the number of tokens in a Message,
        including tools, images, and documents, without creating it.

        Learn more about token counting in our
        [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)

        Args:
          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          output_config: Configuration options for the model's output, such as the output format.


          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        # Transform output_format if provided
        transformed_output_format: Optional[JSONOutputFormatParam] | NotGiven = NOT_GIVEN

        if is_dict(output_format):
            transformed_output_format = cast(JSONOutputFormatParam, output_format)
        elif is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[type] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = JSONOutputFormatParam(schema=transform_schema(schema), type="json_schema")
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        # Merge output_format into output_config
        merged_output_config: OutputConfigParam | Omit = omit
        if is_given(transformed_output_format):
            if is_given(output_config):
                merged_output_config = {**output_config, "format": transformed_output_format}
            else:
                merged_output_config = {"format": transformed_output_format}
        elif is_given(output_config):
            merged_output_config = output_config

        return self._post(
            "/v1/messages/count_tokens",
            body=maybe_transform(
                {
                    "messages": messages,
                    "model": model,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "output_config": merged_output_config,
                    "system": system,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                },
                message_count_tokens_params.MessageCountTokensParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=MessageTokensCount,
        )


class AsyncMessages(AsyncAPIResource):
    @cached_property
    def batches(self) -> AsyncBatches:
        return AsyncBatches(self._client)

    @cached_property
    def with_raw_response(self) -> AsyncMessagesWithRawResponse:
        """
        This property can be used as a prefix for any HTTP method call to return
        the raw response object instead of the parsed content.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#accessing-raw-response-data-eg-headers
        """
        return AsyncMessagesWithRawResponse(self)

    @cached_property
    def with_streaming_response(self) -> AsyncMessagesWithStreamingResponse:
        """
        An alternative to `.with_raw_response` that doesn't eagerly read the response body.

        For more information, see https://www.github.com/anthropics/anthropic-sdk-python#with_streaming_response
        """
        return AsyncMessagesWithStreamingResponse(self)

    @overload
    async def create(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Message:
        """
        Send a structured list of input messages with text and/or image content, and the
        model will generate the next message in the conversation.

        The Messages API can be used for either single queries or stateless multi-turn
        conversations.

        Learn more about the Messages API in our
        [user guide](https://docs.claude.com/en/docs/initial-setup)

        Args:
          max_tokens: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

              Different models have different maximum values for this parameter. See
              [models](https://docs.claude.com/en/docs/models-overview) for details.

          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          container: Container identifier for reuse across requests.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          stop_sequences: Custom text sequences that will cause the model to stop generating.

              Our models will normally stop when they have naturally completed their turn,
              which will result in a response `stop_reason` of `"end_turn"`.

              If you want the model to stop generating when it encounters custom strings of
              text, you can use the `stop_sequences` parameter. If the model encounters one of
              the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
              and the response `stop_sequence` value will contain the matched stop sequence.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.

          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

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
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        stream: Literal[True],
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncStream[RawMessageStreamEvent]:
        """
        Send a structured list of input messages with text and/or image content, and the
        model will generate the next message in the conversation.

        The Messages API can be used for either single queries or stateless multi-turn
        conversations.

        Learn more about the Messages API in our
        [user guide](https://docs.claude.com/en/docs/initial-setup)

        Args:
          max_tokens: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

              Different models have different maximum values for this parameter. See
              [models](https://docs.claude.com/en/docs/models-overview) for details.

          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          container: Container identifier for reuse across requests.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          stop_sequences: Custom text sequences that will cause the model to stop generating.

              Our models will normally stop when they have naturally completed their turn,
              which will result in a response `stop_reason` of `"end_turn"`.

              If you want the model to stop generating when it encounters custom strings of
              text, you can use the `stop_sequences` parameter. If the model encounters one of
              the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
              and the response `stop_sequence` value will contain the matched stop sequence.

          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

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
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        stream: bool,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Message | AsyncStream[RawMessageStreamEvent]:
        """
        Send a structured list of input messages with text and/or image content, and the
        model will generate the next message in the conversation.

        The Messages API can be used for either single queries or stateless multi-turn
        conversations.

        Learn more about the Messages API in our
        [user guide](https://docs.claude.com/en/docs/initial-setup)

        Args:
          max_tokens: The maximum number of tokens to generate before stopping.

              Note that our models may stop _before_ reaching this maximum. This parameter
              only specifies the absolute maximum number of tokens to generate.

              Different models have different maximum values for this parameter. See
              [models](https://docs.claude.com/en/docs/models-overview) for details.

          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          stream: Whether to incrementally stream the response using server-sent events.

              See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          container: Container identifier for reuse across requests.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          stop_sequences: Custom text sequences that will cause the model to stop generating.

              Our models will normally stop when they have naturally completed their turn,
              which will result in a response `stop_reason` of `"end_turn"`.

              If you want the model to stop generating when it encounters custom strings of
              text, you can use the `stop_sequences` parameter. If the model encounters one of
              the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
              and the response `stop_sequence` value will contain the matched stop sequence.

          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          temperature: Amount of randomness injected into the response.

              Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
              for analytical / multiple choice, and closer to `1.0` for creative and
              generative tasks.

              Note that even with `temperature` of `0.0`, the results will not be fully
              deterministic.

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          top_k: Only sample from the top K options for each subsequent token.

              Used to remove "long tail" low probability responses.
              [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

              Recommended for advanced use cases only.

          top_p: Use nucleus sampling.

              In nucleus sampling, we compute the cumulative distribution over all the options
              for each subsequent token in decreasing probability order and cut it off once it
              reaches a particular probability specified by `top_p`.

              Recommended for advanced use cases only.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        ...

    @required_args(["max_tokens", "messages", "model"], ["max_tokens", "messages", "model", "stream"])
    async def create(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        container: Optional[str] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Message | AsyncStream[RawMessageStreamEvent]:
        if not stream and not is_given(timeout) and self._client.timeout == DEFAULT_TIMEOUT:
            timeout = self._client._calculate_nonstreaming_timeout(
                max_tokens, MODEL_NONSTREAMING_TOKENS.get(model, None)
            )

        if model in DEPRECATED_MODELS:
            warnings.warn(
                f"The model '{model}' is deprecated and will reach end-of-life on {DEPRECATED_MODELS[model]}.\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.",
                DeprecationWarning,
                stacklevel=3,
            )

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        return await self._post(
            "/v1/messages",
            body=await async_maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "container": container,
                    "inference_geo": inference_geo,
                    "metadata": metadata,
                    "output_config": output_config,
                    "service_tier": service_tier,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                },
                message_create_params.MessageCreateParamsStreaming
                if stream
                else message_create_params.MessageCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Message,
            stream=stream or False,
            stream_cls=AsyncStream[RawMessageStreamEvent],
        )

    def stream(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        output_format: None | JSONOutputFormatParam | type[ResponseFormatT] | Omit = omit,
        container: Optional[str] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> AsyncMessageStreamManager[ResponseFormatT]:
        """Create a Message stream"""
        if model in DEPRECATED_MODELS:
            warnings.warn(
                f"The model '{model}' is deprecated and will reach end-of-life on {DEPRECATED_MODELS[model]}.\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.",
                DeprecationWarning,
                stacklevel=3,
            )

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        extra_headers = {
            "X-Stainless-Helper-Method": "stream",
            "X-Stainless-Stream-Helper": "messages",
            **(extra_headers or {}),
        }

        transformed_output_format: Optional[JSONOutputFormatParam] | NotGiven = NOT_GIVEN

        if is_dict(output_format):
            transformed_output_format = cast(JSONOutputFormatParam, output_format)
        elif is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = JSONOutputFormatParam(schema=transform_schema(schema), type="json_schema")
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        # Merge output_format into output_config
        merged_output_config: OutputConfigParam | Omit = omit
        if is_given(transformed_output_format):
            if is_given(output_config):
                merged_output_config = {**output_config, "format": transformed_output_format}
            else:
                merged_output_config = {"format": transformed_output_format}
        elif is_given(output_config):
            merged_output_config = output_config

        request = self._post(
            "/v1/messages",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "inference_geo": inference_geo,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "container": container,
                    "service_tier": service_tier,
                    "stop_sequences": stop_sequences,
                    "system": system,
                    "temperature": temperature,
                    "top_k": top_k,
                    "top_p": top_p,
                    "tools": tools,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "stream": True,
                },
                message_create_params.MessageCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=Message,
            stream=True,
            stream_cls=AsyncStream[RawMessageStreamEvent],
        )
        return AsyncMessageStreamManager(
            request,
            output_format=NOT_GIVEN if is_dict(output_format) else cast(ResponseFormatT, output_format),
        )

    async def parse(
        self,
        *,
        max_tokens: int,
        messages: Iterable[MessageParam],
        model: ModelParam,
        metadata: MetadataParam | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[ToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> ParsedMessage[ResponseFormatT]:
        if not stream and not is_given(timeout) and self._client.timeout == DEFAULT_TIMEOUT:
            timeout = self._client._calculate_nonstreaming_timeout(
                max_tokens, MODEL_NONSTREAMING_TOKENS.get(model, None)
            )

        if model in DEPRECATED_MODELS:
            warnings.warn(
                f"The model '{model}' is deprecated and will reach end-of-life on {DEPRECATED_MODELS[model]}.\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.",
                DeprecationWarning,
                stacklevel=3,
            )

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        extra_headers = {
            "X-Stainless-Helper": "messages.parse",
            **(extra_headers or {}),
        }

        transformed_output_format: Optional[JSONOutputFormatParam] | NotGiven = NOT_GIVEN

        if is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = JSONOutputFormatParam(schema=transform_schema(schema), type="json_schema")
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        def parser(response: Message) -> ParsedMessage[ResponseFormatT]:
            return parse_response(
                response=response,
                output_format=cast(
                    ResponseFormatT,
                    output_format if is_given(output_format) and output_format is not None else NOT_GIVEN,
                ),
            )

        # Merge output_format into output_config
        merged_output_config: OutputConfigParam | Omit = omit
        if is_given(transformed_output_format):
            if is_given(output_config):
                merged_output_config = {**output_config, "format": transformed_output_format}
            else:
                merged_output_config = {"format": transformed_output_format}
        elif is_given(output_config):
            merged_output_config = output_config

        return await self._post(
            "/v1/messages",
            body=await async_maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "service_tier": service_tier,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                },
                message_create_params.MessageCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers,
                extra_query=extra_query,
                extra_body=extra_body,
                timeout=timeout,
                post_parser=parser,
            ),
            cast_to=cast(Type[ParsedMessage[ResponseFormatT]], Message),
            stream=False,
        )

    async def count_tokens(
        self,
        *,
        messages: Iterable[MessageParam],
        model: ModelParam,
        cache_control: Optional[CacheControlEphemeralParam] | Omit = omit,
        output_config: OutputConfigParam | Omit = omit,
        output_format: None | JSONOutputFormatParam | type | Omit = omit,
        system: Union[str, Iterable[TextBlockParam]] | Omit = omit,
        thinking: ThinkingConfigParam | Omit = omit,
        tool_choice: ToolChoiceParam | Omit = omit,
        tools: Iterable[MessageCountTokensToolParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> MessageTokensCount:
        """
        Count the number of tokens in a Message.

        The Token Count API can be used to count the number of tokens in a Message,
        including tools, images, and documents, without creating it.

        Learn more about token counting in our
        [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)

        Args:
          messages: Input messages.

              Our models are trained to operate on alternating `user` and `assistant`
              conversational turns. When creating a new `Message`, you specify the prior
              conversational turns with the `messages` parameter, and the model then generates
              the next `Message` in the conversation. Consecutive `user` or `assistant` turns
              in your request will be combined into a single turn.

              Each input message must be an object with a `role` and `content`. You can
              specify a single `user`-role message, or you can include multiple `user` and
              `assistant` messages.

              If the final message uses the `assistant` role, the response content will
              continue immediately from the content in that message. This can be used to
              constrain part of the model's response.

              Example with a single `user` message:

              ```json
              [{ "role": "user", "content": "Hello, Claude" }]
              ```

              Example with multiple conversational turns:

              ```json
              [
                { "role": "user", "content": "Hello there." },
                { "role": "assistant", "content": "Hi, I'm Claude. How can I help you?" },
                { "role": "user", "content": "Can you explain LLMs in plain English?" }
              ]
              ```

              Example with a partially-filled response from Claude:

              ```json
              [
                {
                  "role": "user",
                  "content": "What's the Greek name for Sun? (A) Sol (B) Helios (C) Sun"
                },
                { "role": "assistant", "content": "The best answer is (" }
              ]
              ```

              Each input message `content` may be either a single `string` or an array of
              content blocks, where each block has a specific `type`. Using a `string` for
              `content` is shorthand for an array of one content block of type `"text"`. The
              following input messages are equivalent:

              ```json
              { "role": "user", "content": "Hello, Claude" }
              ```

              ```json
              { "role": "user", "content": [{ "type": "text", "text": "Hello, Claude" }] }
              ```

              See [input examples](https://docs.claude.com/en/api/messages-examples).

              Note that if you want to include a
              [system prompt](https://docs.claude.com/en/docs/system-prompts), you can use the
              top-level `system` parameter — there is no `"system"` role for input messages in
              the Messages API.

              There is a limit of 100,000 messages in a single request.

          model: The model that will complete your prompt.\n\nSee
              [models](https://docs.anthropic.com/en/docs/models-overview) for additional
              details and options.

          cache_control: Top-level cache control automatically applies a cache_control marker to the last
              cacheable block in the request.

          output_config: Configuration options for the model's output, such as the output format.


          system: System prompt.

              A system prompt is a way of providing context and instructions to Claude, such
              as specifying a particular goal or role. See our
              [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).

          thinking: Configuration for enabling Claude's extended thinking.

              When enabled, responses include `thinking` content blocks showing Claude's
              thinking process before the final answer. Requires a minimum budget of 1,024
              tokens and counts towards your `max_tokens` limit.

              See
              [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
              for details.

          tool_choice: How the model should use the provided tools. The model can use a specific tool,
              any available tool, decide by itself, or not use tools at all.

          tools: Definitions of tools that the model may use.

              If you include `tools` in your API request, the model may return `tool_use`
              content blocks that represent the model's use of those tools. You can then run
              those tools using the tool input generated by the model and then optionally
              return results back to the model using `tool_result` content blocks.

              There are two types of tools: **client tools** and **server tools**. The
              behavior described below applies to client tools. For
              [server tools](https://docs.claude.com/en/docs/agents-and-tools/tool-use/overview#server-tools),
              see their individual documentation as each has its own behavior (e.g., the
              [web search tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/web-search-tool)).

              Each tool definition includes:

              - `name`: Name of the tool.
              - `description`: Optional, but strongly-recommended description of the tool.
              - `input_schema`: [JSON schema](https://json-schema.org/draft/2020-12) for the
                tool `input` shape that the model will produce in `tool_use` output content
                blocks.

              For example, if you defined `tools` as:

              ```json
              [
                {
                  "name": "get_stock_price",
                  "description": "Get the current stock price for a given ticker symbol.",
                  "input_schema": {
                    "type": "object",
                    "properties": {
                      "ticker": {
                        "type": "string",
                        "description": "The stock ticker symbol, e.g. AAPL for Apple Inc."
                      }
                    },
                    "required": ["ticker"]
                  }
                }
              ]
              ```

              And then asked the model "What's the S&P 500 at today?", the model might produce
              `tool_use` content blocks in the response like this:

              ```json
              [
                {
                  "type": "tool_use",
                  "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "name": "get_stock_price",
                  "input": { "ticker": "^GSPC" }
                }
              ]
              ```

              You might then run your `get_stock_price` tool with `{"ticker": "^GSPC"}` as an
              input, and return the following back to the model in a subsequent `user`
              message:

              ```json
              [
                {
                  "type": "tool_result",
                  "tool_use_id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV",
                  "content": "259.75 USD"
                }
              ]
              ```

              Tools can be used for workflows that include running client-side tools and
              functions, or more generally whenever you want the model to produce a particular
              JSON structure of output.

              See our [guide](https://docs.claude.com/en/docs/tool-use) for more details.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        # Transform output_format if provided
        transformed_output_format: Optional[JSONOutputFormatParam] | NotGiven = NOT_GIVEN

        if is_dict(output_format):
            transformed_output_format = cast(JSONOutputFormatParam, output_format)
        elif is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[type] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = JSONOutputFormatParam(schema=transform_schema(schema), type="json_schema")
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        # Merge output_format into output_config
        merged_output_config: OutputConfigParam | Omit = omit
        if is_given(transformed_output_format):
            if is_given(output_config):
                merged_output_config = {**output_config, "format": transformed_output_format}
            else:
                merged_output_config = {"format": transformed_output_format}
        elif is_given(output_config):
            merged_output_config = output_config

        return await self._post(
            "/v1/messages/count_tokens",
            body=await async_maybe_transform(
                {
                    "messages": messages,
                    "model": model,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "output_config": merged_output_config,
                    "system": system,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                },
                message_count_tokens_params.MessageCountTokensParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=MessageTokensCount,
        )


class MessagesWithRawResponse:
    def __init__(self, messages: Messages) -> None:
        self._messages = messages

        self.create = _legacy_response.to_raw_response_wrapper(
            messages.create,
        )
        self.count_tokens = _legacy_response.to_raw_response_wrapper(
            messages.count_tokens,
        )

    @cached_property
    def batches(self) -> BatchesWithRawResponse:
        return BatchesWithRawResponse(self._messages.batches)


class AsyncMessagesWithRawResponse:
    def __init__(self, messages: AsyncMessages) -> None:
        self._messages = messages

        self.create = _legacy_response.async_to_raw_response_wrapper(
            messages.create,
        )
        self.count_tokens = _legacy_response.async_to_raw_response_wrapper(
            messages.count_tokens,
        )

    @cached_property
    def batches(self) -> AsyncBatchesWithRawResponse:
        return AsyncBatchesWithRawResponse(self._messages.batches)


class MessagesWithStreamingResponse:
    def __init__(self, messages: Messages) -> None:
        self._messages = messages

        self.create = to_streamed_response_wrapper(
            messages.create,
        )
        self.count_tokens = to_streamed_response_wrapper(
            messages.count_tokens,
        )

    @cached_property
    def batches(self) -> BatchesWithStreamingResponse:
        return BatchesWithStreamingResponse(self._messages.batches)


class AsyncMessagesWithStreamingResponse:
    def __init__(self, messages: AsyncMessages) -> None:
        self._messages = messages

        self.create = async_to_streamed_response_wrapper(
            messages.create,
        )
        self.count_tokens = async_to_streamed_response_wrapper(
            messages.count_tokens,
        )

    @cached_property
    def batches(self) -> AsyncBatchesWithStreamingResponse:
        return AsyncBatchesWithStreamingResponse(self._messages.batches)
