# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

import inspect
import warnings
from typing import TYPE_CHECKING, List, Type, Union, Iterable, Optional, cast
from functools import partial
from itertools import chain
from typing_extensions import Literal, overload

import httpx
import pydantic

from .... import _legacy_response
from .batches import (
    Batches,
    AsyncBatches,
    BatchesWithRawResponse,
    AsyncBatchesWithRawResponse,
    BatchesWithStreamingResponse,
    AsyncBatchesWithStreamingResponse,
)
from ...._types import NOT_GIVEN, Body, Omit, Query, Headers, NotGiven, SequenceNotStr, omit, not_given
from ...._utils import is_given, required_args, maybe_transform, strip_not_given, async_maybe_transform
from ...._compat import cached_property
from ...._models import TypeAdapter
from ...._resource import SyncAPIResource, AsyncAPIResource
from ...._response import to_streamed_response_wrapper, async_to_streamed_response_wrapper
from ....lib.tools import (
    BetaToolRunner,
    BetaAsyncToolRunner,
    BetaStreamingToolRunner,
    BetaAsyncStreamingToolRunner,
)
from ...._constants import DEFAULT_TIMEOUT, MODEL_NONSTREAMING_TOKENS
from ...._streaming import Stream, AsyncStream
from ....types.beta import (
    BetaThinkingConfigParam,
    message_create_params,
    message_count_tokens_params,
)
from ...._exceptions import AnthropicError
from ...._base_client import make_request_options
from ...._utils._utils import is_dict
from ....lib.streaming import BetaMessageStreamManager, BetaAsyncMessageStreamManager
from ...messages.messages import DEPRECATED_MODELS, MODELS_TO_WARN_WITH_THINKING_ENABLED
from ....types.model_param import ModelParam
from ....lib._parse._response import ResponseFormatT, parse_beta_response
from ....lib._parse._transform import transform_schema
from ....lib._stainless_helpers import stainless_helper_header as _stainless_helper_header
from ....types.beta.beta_message import BetaMessage
from ....lib.tools._beta_functions import (
    BetaFunctionTool,
    BetaRunnableTool,
    BetaAsyncFunctionTool,
    BetaAsyncRunnableTool,
    BetaBuiltinFunctionTool,
    BetaAsyncBuiltinFunctionTool,
)
from ....types.anthropic_beta_param import AnthropicBetaParam
from ....types.beta.beta_message_param import BetaMessageParam
from ....types.beta.beta_metadata_param import BetaMetadataParam
from ....types.beta.parsed_beta_message import ParsedBetaMessage
from ....types.beta.beta_text_block_param import BetaTextBlockParam
from ....types.beta.beta_tool_union_param import BetaToolUnionParam
from ....types.beta.beta_tool_choice_param import BetaToolChoiceParam
from ....lib.tools._beta_compaction_control import CompactionControl
from ....types.beta.beta_output_config_param import BetaOutputConfigParam
from ....types.beta.beta_message_tokens_count import BetaMessageTokensCount
from ....types.beta.beta_thinking_config_param import BetaThinkingConfigParam
from ....types.beta.beta_json_output_format_param import BetaJSONOutputFormatParam
from ....types.beta.beta_raw_message_stream_event import BetaRawMessageStreamEvent
from ....types.beta.beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from ....types.beta.beta_context_management_config_param import BetaContextManagementConfigParam
from ....types.beta.beta_request_mcp_server_url_definition_param import BetaRequestMCPServerURLDefinitionParam

if TYPE_CHECKING:
    from ...._client import Anthropic, AsyncAnthropic

__all__ = ["Messages", "AsyncMessages"]


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
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessage:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          mcp_servers: MCP servers to be utilized in this request

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          user_profile_id: The user profile ID to attribute this request to. Use when acting on behalf of a
              party other than your organization.

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
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        stream: Literal[True],
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> Stream[BetaRawMessageStreamEvent]:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          mcp_servers: MCP servers to be utilized in this request

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          user_profile_id: The user profile ID to attribute this request to. Use when acting on behalf of a
              party other than your organization.

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
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        stream: bool,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessage | Stream[BetaRawMessageStreamEvent]:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          mcp_servers: MCP servers to be utilized in this request

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          user_profile_id: The user profile ID to attribute this request to. Use when acting on behalf of a
              party other than your organization.

          betas: Optional header to specify the beta version(s) you want to use.

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
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessage | Stream[BetaRawMessageStreamEvent]:
        validate_output_format(output_format)
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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

        merged_output_config = _merge_output_configs(output_config, output_format)

        extra_headers = {
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else not_given}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }
        return self._post(
            "/v1/messages?beta=true",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "container": container,
                    "context_management": context_management,
                    "inference_geo": inference_geo,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "service_tier": service_tier,
                    "speed": speed,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                    "user_profile_id": user_profile_id,
                },
                message_create_params.MessageCreateParamsStreaming
                if stream
                else message_create_params.MessageCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaMessage,
            stream=stream or False,
            stream_cls=Stream[BetaRawMessageStreamEvent],
        )

    def parse(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> ParsedBetaMessage[ResponseFormatT]:
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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

        betas = [beta for beta in betas] if is_given(betas) else []

        if "structured-outputs-2025-12-15" not in betas:
            # Ensure structured outputs beta is included for parse method
            betas.append("structured-outputs-2025-12-15")

        extra_headers = {
            "X-Stainless-Helper": "beta.messages.parse",
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else NOT_GIVEN}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }

        if is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = BetaJSONOutputFormatParam(
                    schema=transform_schema(schema), type="json_schema"
                )
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

            merged_output_config = _merge_output_configs(output_config, transformed_output_format)
        else:
            merged_output_config = output_config

        def parser(response: BetaMessage) -> ParsedBetaMessage[ResponseFormatT]:
            return parse_beta_response(
                response=response,
                output_format=cast(
                    ResponseFormatT,
                    output_format if is_given(output_format) and output_format is not None else NOT_GIVEN,
                ),
            )

        return self._post(
            "/v1/messages?beta=true",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "container": container,
                    "context_management": context_management,
                    "inference_geo": inference_geo,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "service_tier": service_tier,
                    "speed": speed,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                    "user_profile_id": user_profile_id,
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
            cast_to=cast(Type[ParsedBetaMessage[ResponseFormatT]], BetaMessage),
            stream=False,
        )

    @overload
    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaRunnableTool | BetaToolUnionParam],
        compaction_control: CompactionControl | Omit = omit,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        max_iterations: int | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaToolRunner[ResponseFormatT]: ...

    @overload
    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaRunnableTool | BetaToolUnionParam],
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        compaction_control: CompactionControl | Omit = omit,
        stream: Literal[True],
        max_iterations: int | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaStreamingToolRunner[ResponseFormatT]: ...

    @overload
    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaRunnableTool | BetaToolUnionParam],
        compaction_control: CompactionControl | Omit = omit,
        stream: bool,
        max_iterations: int | Omit = omit,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaStreamingToolRunner[ResponseFormatT] | BetaToolRunner[ResponseFormatT]: ...

    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaRunnableTool | BetaToolUnionParam],
        compaction_control: CompactionControl | Omit = omit,
        max_iterations: int | Omit = omit,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: bool | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaStreamingToolRunner[ResponseFormatT] | BetaToolRunner[ResponseFormatT]:
        """Create a Message stream"""
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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

        if model in MODELS_TO_WARN_WITH_THINKING_ENABLED and thinking and thinking["type"] == "enabled":
            warnings.warn(
                f"Using Claude with {model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking",
                UserWarning,
                stacklevel=3,
            )

        extra_headers = {
            "X-Stainless-Helper": "BetaToolRunner",
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else NOT_GIVEN}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }

        runnable_tools: list[BetaRunnableTool] = []
        raw_tools: list[BetaToolUnionParam] = []

        for tool in tools:
            if isinstance(tool, (BetaFunctionTool, BetaBuiltinFunctionTool)):
                runnable_tools.append(tool)
            else:
                raw_tools.append(tool)

        params = cast(
            message_create_params.ParseMessageCreateParamsBase[ResponseFormatT],
            {
                "max_tokens": max_tokens,
                "messages": messages,
                "model": model,
                "cache_control": cache_control,
                "container": container,
                "context_management": context_management,
                "inference_geo": inference_geo,
                "mcp_servers": mcp_servers,
                "metadata": metadata,
                "output_config": output_config,
                "output_format": output_format,
                "service_tier": service_tier,
                "speed": speed,
                "stop_sequences": stop_sequences,
                "system": system,
                "temperature": temperature,
                "thinking": thinking,
                "tool_choice": tool_choice,
                "tools": [*[tool.to_dict() for tool in runnable_tools], *raw_tools],
                "top_k": top_k,
                "top_p": top_p,
                "user_profile_id": user_profile_id,
            },
        )

        if stream:
            return BetaStreamingToolRunner[ResponseFormatT](
                tools=runnable_tools,
                params=params,
                options={
                    "extra_headers": extra_headers,
                    "extra_query": extra_query,
                    "extra_body": extra_body,
                    "timeout": timeout,
                },
                client=cast("Anthropic", self._client),
                max_iterations=max_iterations if is_given(max_iterations) else None,
                compaction_control=compaction_control if is_given(compaction_control) else None,
            )
        return BetaToolRunner[ResponseFormatT](
            tools=runnable_tools,
            params=params,
            options={
                "extra_headers": extra_headers,
                "extra_query": extra_query,
                "extra_body": extra_body,
                "timeout": timeout,
            },
            client=cast("Anthropic", self._client),
            max_iterations=max_iterations if is_given(max_iterations) else None,
            compaction_control=compaction_control if is_given(compaction_control) else None,
        )

    def stream(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: None | BetaJSONOutputFormatParam | type[ResponseFormatT] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaMessageStreamManager[ResponseFormatT]:
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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

        """Create a Message stream"""
        extra_headers = {
            "X-Stainless-Helper-Method": "stream",
            "X-Stainless-Stream-Helper": "beta.messages",
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else NOT_GIVEN}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }

        transformed_output_format: BetaJSONOutputFormatParam | Omit = omit

        if is_dict(output_format):
            transformed_output_format = cast(BetaJSONOutputFormatParam, output_format)
        elif is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = BetaJSONOutputFormatParam(
                    schema=transform_schema(schema), type="json_schema"
                )
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        merged_output_config = _merge_output_configs(output_config, transformed_output_format)

        make_request = partial(
            self._post,
            "/v1/messages?beta=true",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "container": container,
                    "context_management": context_management,
                    "inference_geo": inference_geo,
                    "mcp_servers": mcp_servers,
                    "service_tier": service_tier,
                    "speed": speed,
                    "stop_sequences": stop_sequences,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "top_k": top_k,
                    "top_p": top_p,
                    "tools": tools,
                    "tool_choice": tool_choice,
                    "user_profile_id": user_profile_id,
                    "stream": True,
                },
                message_create_params.MessageCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaMessage,
            stream=True,
            stream_cls=Stream[BetaRawMessageStreamEvent],
        )
        return BetaMessageStreamManager(
            make_request,
            output_format=NOT_GIVEN if is_dict(output_format) else cast(ResponseFormatT, output_format),
        )

    def count_tokens(
        self,
        *,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[message_count_tokens_params.Tool] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessageTokensCount:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          mcp_servers: MCP servers to be utilized in this request

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

        merged_output_config = _merge_output_configs(output_config, output_format)

        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["token-counting-2024-11-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "token-counting-2024-11-01", **(extra_headers or {})}
        return self._post(
            "/v1/messages/count_tokens?beta=true",
            body=maybe_transform(
                {
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "context_management": context_management,
                    "mcp_servers": mcp_servers,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "speed": speed,
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
            cast_to=BetaMessageTokensCount,
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
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessage:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          mcp_servers: MCP servers to be utilized in this request

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          user_profile_id: The user profile ID to attribute this request to. Use when acting on behalf of a
              party other than your organization.

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
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        stream: Literal[True],
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> AsyncStream[BetaRawMessageStreamEvent]:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          mcp_servers: MCP servers to be utilized in this request

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          user_profile_id: The user profile ID to attribute this request to. Use when acting on behalf of a
              party other than your organization.

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
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        stream: bool,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessage | AsyncStream[BetaRawMessageStreamEvent]:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          inference_geo: Specifies the geographic region for inference processing. If not specified, the
              workspace's `default_inference_geo` is used.

          mcp_servers: MCP servers to be utilized in this request

          metadata: An object describing metadata about the request.

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          service_tier: Determines whether to use priority capacity (if available) or standard capacity
              for this request.

              Anthropic offers different levels of service for your API requests. See
              [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          user_profile_id: The user profile ID to attribute this request to. Use when acting on behalf of a
              party other than your organization.

          betas: Optional header to specify the beta version(s) you want to use.

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
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessage | AsyncStream[BetaRawMessageStreamEvent]:
        validate_output_format(output_format)
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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

        merged_output_config = _merge_output_configs(output_config, output_format)

        extra_headers = {
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else not_given}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }
        return await self._post(
            "/v1/messages?beta=true",
            body=await async_maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "container": container,
                    "context_management": context_management,
                    "inference_geo": inference_geo,
                    "mcp_servers": mcp_servers,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "service_tier": service_tier,
                    "speed": speed,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                    "user_profile_id": user_profile_id,
                },
                message_create_params.MessageCreateParamsStreaming
                if stream
                else message_create_params.MessageCreateParamsNonStreaming,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaMessage,
            stream=stream or False,
            stream_cls=AsyncStream[BetaRawMessageStreamEvent],
        )

    async def parse(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Literal[True] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> ParsedBetaMessage[ResponseFormatT]:
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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
        betas = [beta for beta in betas] if is_given(betas) else []

        if "structured-outputs-2025-12-15" not in betas:
            # Ensure structured outputs beta is included for parse method
            betas.append("structured-outputs-2025-12-15")

        extra_headers = {
            "X-Stainless-Helper": "beta.messages.parse",
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else NOT_GIVEN}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }

        if is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = BetaJSONOutputFormatParam(
                    schema=transform_schema(schema), type="json_schema"
                )
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

            merged_output_config = _merge_output_configs(output_config, transformed_output_format)
        else:
            merged_output_config = output_config

        def parser(response: BetaMessage) -> ParsedBetaMessage[ResponseFormatT]:
            return parse_beta_response(
                response=response,
                output_format=cast(
                    ResponseFormatT,
                    output_format if is_given(output_format) and output_format is not None else NOT_GIVEN,
                ),
            )

        return await self._post(
            "/v1/messages?beta=true",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "container": container,
                    "context_management": context_management,
                    "inference_geo": inference_geo,
                    "mcp_servers": mcp_servers,
                    "output_config": merged_output_config,
                    "metadata": metadata,
                    "output_format": omit,
                    "service_tier": service_tier,
                    "speed": speed,
                    "stop_sequences": stop_sequences,
                    "stream": stream,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "tool_choice": tool_choice,
                    "tools": tools,
                    "top_k": top_k,
                    "top_p": top_p,
                    "user_profile_id": user_profile_id,
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
            cast_to=cast(Type[ParsedBetaMessage[ResponseFormatT]], BetaMessage),
            stream=False,
        )

    @overload
    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaAsyncRunnableTool | BetaToolUnionParam],
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        compaction_control: CompactionControl | Omit = omit,
        max_iterations: int | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[False] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaAsyncToolRunner[ResponseFormatT]: ...

    @overload
    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaAsyncRunnableTool | BetaToolUnionParam],
        compaction_control: CompactionControl | Omit = omit,
        stream: Literal[True],
        max_iterations: int | Omit = omit,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaAsyncStreamingToolRunner[ResponseFormatT]: ...

    @overload
    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaAsyncRunnableTool | BetaToolUnionParam],
        compaction_control: CompactionControl | Omit = omit,
        stream: bool,
        max_iterations: int | Omit = omit,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaAsyncStreamingToolRunner[ResponseFormatT] | BetaAsyncToolRunner[ResponseFormatT]: ...

    def tool_runner(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        tools: Iterable[BetaAsyncRunnableTool | BetaToolUnionParam],
        compaction_control: CompactionControl | Omit = omit,
        max_iterations: int | Omit = omit,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[type[ResponseFormatT]] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        stream: Literal[True] | Literal[False] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaAsyncToolRunner[ResponseFormatT] | BetaAsyncStreamingToolRunner[ResponseFormatT]:
        """Create a Message stream"""
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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
            "X-Stainless-Helper": "BetaToolRunner",
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else NOT_GIVEN}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }

        runnable_tools: list[BetaAsyncRunnableTool] = []
        raw_tools: list[BetaToolUnionParam] = []

        for tool in tools:
            if isinstance(tool, (BetaAsyncFunctionTool, BetaAsyncBuiltinFunctionTool)):
                runnable_tools.append(tool)
            else:
                raw_tools.append(tool)

        params = cast(
            message_create_params.ParseMessageCreateParamsBase[ResponseFormatT],
            {
                "max_tokens": max_tokens,
                "messages": messages,
                "model": model,
                "cache_control": cache_control,
                "container": container,
                "context_management": context_management,
                "inference_geo": inference_geo,
                "mcp_servers": mcp_servers,
                "metadata": metadata,
                "output_config": output_config,
                "output_format": output_format,
                "service_tier": service_tier,
                "speed": speed,
                "stop_sequences": stop_sequences,
                "system": system,
                "temperature": temperature,
                "thinking": thinking,
                "tool_choice": tool_choice,
                "tools": [*[tool.to_dict() for tool in runnable_tools], *raw_tools],
                "top_k": top_k,
                "top_p": top_p,
                "user_profile_id": user_profile_id,
            },
        )

        if stream:
            return BetaAsyncStreamingToolRunner[ResponseFormatT](
                tools=runnable_tools,
                params=params,
                options={
                    "extra_headers": extra_headers,
                    "extra_query": extra_query,
                    "extra_body": extra_body,
                    "timeout": timeout,
                },
                client=cast("AsyncAnthropic", self._client),
                max_iterations=max_iterations if is_given(max_iterations) else None,
                compaction_control=compaction_control if is_given(compaction_control) else None,
            )
        return BetaAsyncToolRunner[ResponseFormatT](
            tools=runnable_tools,
            params=params,
            options={
                "extra_headers": extra_headers,
                "extra_query": extra_query,
                "extra_body": extra_body,
                "timeout": timeout,
            },
            client=cast("AsyncAnthropic", self._client),
            max_iterations=max_iterations if is_given(max_iterations) else None,
            compaction_control=compaction_control if is_given(compaction_control) else None,
        )

    def stream(
        self,
        *,
        max_tokens: int,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        metadata: BetaMetadataParam | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: None | type[ResponseFormatT] | BetaJSONOutputFormatParam | Omit = omit,
        container: Optional[message_create_params.Container] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        inference_geo: Optional[str] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        service_tier: Literal["auto", "standard_only"] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        stop_sequences: SequenceNotStr[str] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        temperature: float | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[BetaToolUnionParam] | Omit = omit,
        top_k: int | Omit = omit,
        top_p: float | Omit = omit,
        user_profile_id: Optional[str] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = NOT_GIVEN,
    ) -> BetaAsyncMessageStreamManager[ResponseFormatT]:
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

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
            "X-Stainless-Stream-Helper": "beta.messages",
            **strip_not_given({"anthropic-beta": ",".join(str(e) for e in betas) if is_given(betas) else NOT_GIVEN}),
            **_stainless_helper_header(tools, messages),
            **(extra_headers or {}),
        }

        transformed_output_format: BetaJSONOutputFormatParam | Omit = omit

        if is_dict(output_format):
            transformed_output_format = cast(BetaJSONOutputFormatParam, output_format)
        elif is_given(output_format) and output_format is not None:
            adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)

            try:
                schema = adapted_type.json_schema()
                transformed_output_format = BetaJSONOutputFormatParam(
                    schema=transform_schema(schema), type="json_schema"
                )
            except pydantic.errors.PydanticSchemaGenerationError as e:
                raise TypeError(
                    (
                        "Could not generate JSON schema for the given `output_format` type. "
                        "Use a type that works with `pydantic.TypeAdapter`"
                    )
                ) from e

        merged_output_config = _merge_output_configs(output_config, transformed_output_format)

        request = self._post(
            "/v1/messages?beta=true",
            body=maybe_transform(
                {
                    "max_tokens": max_tokens,
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "metadata": metadata,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "container": container,
                    "context_management": context_management,
                    "inference_geo": inference_geo,
                    "mcp_servers": mcp_servers,
                    "service_tier": service_tier,
                    "speed": speed,
                    "stop_sequences": stop_sequences,
                    "system": system,
                    "temperature": temperature,
                    "thinking": thinking,
                    "top_k": top_k,
                    "top_p": top_p,
                    "tools": tools,
                    "tool_choice": tool_choice,
                    "user_profile_id": user_profile_id,
                    "stream": True,
                },
                message_create_params.MessageCreateParams,
            ),
            options=make_request_options(
                extra_headers=extra_headers, extra_query=extra_query, extra_body=extra_body, timeout=timeout
            ),
            cast_to=BetaMessage,
            stream=True,
            stream_cls=AsyncStream[BetaRawMessageStreamEvent],
        )
        return BetaAsyncMessageStreamManager(
            request,
            output_format=NOT_GIVEN if is_dict(output_format) else cast(ResponseFormatT, output_format),
        )

    async def count_tokens(
        self,
        *,
        messages: Iterable[BetaMessageParam],
        model: ModelParam,
        cache_control: Optional[BetaCacheControlEphemeralParam] | Omit = omit,
        context_management: Optional[BetaContextManagementConfigParam] | Omit = omit,
        mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam] | Omit = omit,
        output_config: BetaOutputConfigParam | Omit = omit,
        output_format: Optional[BetaJSONOutputFormatParam] | Omit = omit,
        speed: Optional[Literal["standard", "fast"]] | Omit = omit,
        system: Union[str, Iterable[BetaTextBlockParam]] | Omit = omit,
        thinking: BetaThinkingConfigParam | Omit = omit,
        tool_choice: BetaToolChoiceParam | Omit = omit,
        tools: Iterable[message_count_tokens_params.Tool] | Omit = omit,
        betas: List[AnthropicBetaParam] | Omit = omit,
        # Use the following arguments if you need to pass additional parameters to the API that aren't available via kwargs.
        # The extra values given here take precedence over values defined on the client or passed to this method.
        extra_headers: Headers | None = None,
        extra_query: Query | None = None,
        extra_body: Body | None = None,
        timeout: float | httpx.Timeout | None | NotGiven = not_given,
    ) -> BetaMessageTokensCount:
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

          context_management: Context management configuration.

              This allows you to control how Claude manages context across multiple requests,
              such as whether to clear function results or not.

          mcp_servers: MCP servers to be utilized in this request

          output_config: Configuration options for the model's output, such as the output format.

          output_format: Deprecated: Use `output_config.format` instead. See
              [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

              A schema to specify Claude's output format in responses. This parameter will be
              removed in a future release.

          speed: The inference speed mode for this request. `"fast"` enables high
              output-tokens-per-second inference.

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

          betas: Optional header to specify the beta version(s) you want to use.

          extra_headers: Send extra headers

          extra_query: Add additional query parameters to the request

          extra_body: Add additional JSON properties to the request

          timeout: Override the client-level default timeout for this request, in seconds
        """
        _validate_output_config_conflict(output_config, output_format)
        _warn_output_format_deprecated(output_format)

        merged_output_config = _merge_output_configs(output_config, output_format)

        extra_headers = {
            **strip_not_given(
                {
                    "anthropic-beta": ",".join(chain((str(e) for e in betas), ["token-counting-2024-11-01"]))
                    if is_given(betas)
                    else not_given
                }
            ),
            **(extra_headers or {}),
        }
        extra_headers = {"anthropic-beta": "token-counting-2024-11-01", **(extra_headers or {})}
        return await self._post(
            "/v1/messages/count_tokens?beta=true",
            body=await async_maybe_transform(
                {
                    "messages": messages,
                    "model": model,
                    "cache_control": cache_control,
                    "context_management": context_management,
                    "mcp_servers": mcp_servers,
                    "mcp_servers": mcp_servers,
                    "output_config": merged_output_config,
                    "output_format": omit,
                    "speed": speed,
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
            cast_to=BetaMessageTokensCount,
        )


class MessagesWithRawResponse:
    def __init__(self, messages: Messages) -> None:
        self._messages = messages

        self.create = _legacy_response.to_raw_response_wrapper(
            messages.create,
        )
        self.parse = _legacy_response.to_raw_response_wrapper(
            messages.parse,
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
        self.parse = _legacy_response.async_to_raw_response_wrapper(
            messages.parse,
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


def validate_output_format(output_format: object) -> None:
    if inspect.isclass(output_format) and issubclass(output_format, pydantic.BaseModel):
        raise TypeError(
            "You tried to pass a `BaseModel` class to `beta.messages.create()`; You must use `beta.messages.parse()` instead"
        )


def _validate_output_config_conflict(
    output_config: BetaOutputConfigParam | Omit,
    output_format: object,
) -> None:
    if is_given(output_format) and output_format is not None and is_given(output_config):
        if "format" in output_config and output_config["format"] is not None:
            raise AnthropicError(
                "Both output_format and output_config.format were provided. "
                "Please use only output_config.format (output_format is deprecated).",
            )


def _merge_output_configs(
    output_config: BetaOutputConfigParam | Omit,
    output_format: Optional[BetaJSONOutputFormatParam] | Omit,
) -> BetaOutputConfigParam | Omit:
    if is_given(output_format):
        if is_given(output_config):
            return {**output_config, "format": output_format}
        else:
            return {"format": output_format}
    return output_config


def _warn_output_format_deprecated(output_format: object) -> None:
    """Emit deprecation warning if output_format is provided."""
    if is_given(output_format) and output_format is not None:
        warnings.warn(
            "The 'output_format' parameter is deprecated. Please use 'output_config.format' instead.",
            DeprecationWarning,
            stacklevel=4,
        )
