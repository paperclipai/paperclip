# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Union, Generic, Iterable, Optional
from typing_extensions import Literal, Required, Annotated, TypeAlias, TypedDict

from ..._types import SequenceNotStr
from ..._utils import PropertyInfo
from ..model_param import ModelParam
from .beta_message_param import BetaMessageParam
from .beta_metadata_param import BetaMetadataParam
from .parsed_beta_message import ResponseFormatT
from ..anthropic_beta_param import AnthropicBetaParam
from .beta_container_params import BetaContainerParams
from .beta_text_block_param import BetaTextBlockParam
from .beta_tool_union_param import BetaToolUnionParam
from .beta_tool_choice_param import BetaToolChoiceParam
from .beta_output_config_param import BetaOutputConfigParam
from .beta_thinking_config_param import BetaThinkingConfigParam
from .beta_json_output_format_param import BetaJSONOutputFormatParam
from .beta_cache_control_ephemeral_param import BetaCacheControlEphemeralParam
from .beta_context_management_config_param import BetaContextManagementConfigParam
from .beta_request_mcp_server_url_definition_param import BetaRequestMCPServerURLDefinitionParam

__all__ = [
    "MessageCreateParamsBase",
    "Container",
    "MessageCreateParamsNonStreaming",
    "MessageCreateParamsStreaming",
    "OutputFormat",
]


class MessageCreateParamsBase(TypedDict, total=False):
    max_tokens: Required[int]
    """The maximum number of tokens to generate before stopping.

    Note that our models may stop _before_ reaching this maximum. This parameter
    only specifies the absolute maximum number of tokens to generate.

    Different models have different maximum values for this parameter. See
    [models](https://docs.claude.com/en/docs/models-overview) for details.
    """

    messages: Required[Iterable[BetaMessageParam]]
    """Input messages.

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
    """

    model: Required[ModelParam]
    """
    The model that will complete your prompt.\n\nSee
    [models](https://docs.anthropic.com/en/docs/models-overview) for additional
    details and options.
    """

    cache_control: Optional[BetaCacheControlEphemeralParam]
    """
    Top-level cache control automatically applies a cache_control marker to the last
    cacheable block in the request.
    """

    container: Optional[Container]
    """Container identifier for reuse across requests."""

    context_management: Optional[BetaContextManagementConfigParam]
    """Context management configuration.

    This allows you to control how Claude manages context across multiple requests,
    such as whether to clear function results or not.
    """

    inference_geo: Optional[str]
    """Specifies the geographic region for inference processing.

    If not specified, the workspace's `default_inference_geo` is used.
    """

    mcp_servers: Iterable[BetaRequestMCPServerURLDefinitionParam]
    """MCP servers to be utilized in this request"""

    metadata: BetaMetadataParam
    """An object describing metadata about the request."""

    output_config: BetaOutputConfigParam
    """Configuration options for the model's output, such as the output format."""

    output_format: Optional[BetaJSONOutputFormatParam]
    """Deprecated: Use `output_config.format` instead.

    See
    [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

    A schema to specify Claude's output format in responses. This parameter will be
    removed in a future release.
    """

    service_tier: Literal["auto", "standard_only"]
    """
    Determines whether to use priority capacity (if available) or standard capacity
    for this request.

    Anthropic offers different levels of service for your API requests. See
    [service-tiers](https://docs.claude.com/en/api/service-tiers) for details.
    """

    speed: Optional[Literal["standard", "fast"]]
    """The inference speed mode for this request.

    `"fast"` enables high output-tokens-per-second inference.
    """

    stop_sequences: SequenceNotStr[str]
    """Custom text sequences that will cause the model to stop generating.

    Our models will normally stop when they have naturally completed their turn,
    which will result in a response `stop_reason` of `"end_turn"`.

    If you want the model to stop generating when it encounters custom strings of
    text, you can use the `stop_sequences` parameter. If the model encounters one of
    the custom sequences, the response `stop_reason` value will be `"stop_sequence"`
    and the response `stop_sequence` value will contain the matched stop sequence.
    """

    system: Union[str, Iterable[BetaTextBlockParam]]
    """System prompt.

    A system prompt is a way of providing context and instructions to Claude, such
    as specifying a particular goal or role. See our
    [guide to system prompts](https://docs.claude.com/en/docs/system-prompts).
    """

    temperature: float
    """Amount of randomness injected into the response.

    Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
    for analytical / multiple choice, and closer to `1.0` for creative and
    generative tasks.

    Note that even with `temperature` of `0.0`, the results will not be fully
    deterministic.
    """

    thinking: BetaThinkingConfigParam
    """Configuration for enabling Claude's extended thinking.

    When enabled, responses include `thinking` content blocks showing Claude's
    thinking process before the final answer. Requires a minimum budget of 1,024
    tokens and counts towards your `max_tokens` limit.

    See
    [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking)
    for details.
    """

    tool_choice: BetaToolChoiceParam
    """How the model should use the provided tools.

    The model can use a specific tool, any available tool, decide by itself, or not
    use tools at all.
    """

    tools: Iterable[BetaToolUnionParam]
    """Definitions of tools that the model may use.

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
    """

    top_k: int
    """Only sample from the top K options for each subsequent token.

    Used to remove "long tail" low probability responses.
    [Learn more technical details here](https://towardsdatascience.com/how-to-sample-from-language-models-682bceb97277).

    Recommended for advanced use cases only.
    """

    top_p: float
    """Use nucleus sampling.

    In nucleus sampling, we compute the cumulative distribution over all the options
    for each subsequent token in decreasing probability order and cut it off once it
    reaches a particular probability specified by `top_p`.

    Recommended for advanced use cases only.
    """

    user_profile_id: Optional[str]
    """The user profile ID to attribute this request to.

    Use when acting on behalf of a party other than your organization.
    """

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Container: TypeAlias = Union[BetaContainerParams, str]


class ParseMessageCreateParamsBase(MessageCreateParamsBase, Generic[ResponseFormatT]):
    output_format: type[ResponseFormatT]  # type: ignore[misc]


class OutputFormat(TypedDict, total=False):
    schema: Required[object]
    """The JSON schema of the format"""

    type: Required[Literal["json_schema"]]


class MessageCreateParamsNonStreaming(MessageCreateParamsBase, total=False):
    stream: Literal[False]
    """Whether to incrementally stream the response using server-sent events.

    See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.
    """


class MessageCreateParamsStreaming(MessageCreateParamsBase):
    stream: Required[Literal[True]]
    """Whether to incrementally stream the response using server-sent events.

    See [streaming](https://docs.claude.com/en/api/messages-streaming) for details.
    """


MessageCreateParams = Union[MessageCreateParamsNonStreaming, MessageCreateParamsStreaming]
