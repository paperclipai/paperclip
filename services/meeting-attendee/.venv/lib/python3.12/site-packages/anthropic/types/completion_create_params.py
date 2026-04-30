# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from __future__ import annotations

from typing import List, Union
from typing_extensions import Literal, Required, Annotated, TypeAlias, TypedDict

from .._types import SequenceNotStr
from .._utils import PropertyInfo
from .model_param import ModelParam
from .metadata_param import MetadataParam
from .anthropic_beta_param import AnthropicBetaParam

__all__ = [
    "CompletionRequestStreamingMetadata",
    "CompletionRequestNonStreamingMetadata",
    "CompletionRequestNonStreaming",
    "CompletionRequestStreaming",
    "CompletionCreateParamsBase",
    "Metadata",
    "CompletionCreateParamsNonStreaming",
    "CompletionCreateParamsStreaming",
]


class CompletionCreateParamsBase(TypedDict, total=False):
    max_tokens_to_sample: Required[int]
    """The maximum number of tokens to generate before stopping.

    Note that our models may stop _before_ reaching this maximum. This parameter
    only specifies the absolute maximum number of tokens to generate.
    """

    model: Required[ModelParam]
    """
    The model that will complete your prompt.\n\nSee
    [models](https://docs.anthropic.com/en/docs/models-overview) for additional
    details and options.
    """

    prompt: Required[str]
    """The prompt that you want Claude to complete.

    For proper response generation you will need to format your prompt using
    alternating `\n\nHuman:` and `\n\nAssistant:` conversational turns. For example:

    ```
    "\n\nHuman: {userQuestion}\n\nAssistant:"
    ```

    See [prompt validation](https://docs.claude.com/en/api/prompt-validation) and
    our guide to [prompt design](https://docs.claude.com/en/docs/intro-to-prompting)
    for more details.
    """

    metadata: MetadataParam
    """An object describing metadata about the request."""

    stop_sequences: SequenceNotStr[str]
    """Sequences that will cause the model to stop generating.

    Our models stop on `"\n\nHuman:"`, and may include additional built-in stop
    sequences in the future. By providing the stop_sequences parameter, you may
    include additional strings that will cause the model to stop generating.
    """

    temperature: float
    """Amount of randomness injected into the response.

    Defaults to `1.0`. Ranges from `0.0` to `1.0`. Use `temperature` closer to `0.0`
    for analytical / multiple choice, and closer to `1.0` for creative and
    generative tasks.

    Note that even with `temperature` of `0.0`, the results will not be fully
    deterministic.
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

    betas: Annotated[List[AnthropicBetaParam], PropertyInfo(alias="anthropic-beta")]
    """Optional header to specify the beta version(s) you want to use."""


Metadata: TypeAlias = MetadataParam
"""This is deprecated, `MetadataParam` should be used instead"""


class CompletionCreateParamsNonStreaming(CompletionCreateParamsBase, total=False):
    stream: Literal[False]
    """Whether to incrementally stream the response using server-sent events.

    See [streaming](https://docs.claude.com/en/api/streaming) for details.
    """


class CompletionCreateParamsStreaming(CompletionCreateParamsBase):
    stream: Required[Literal[True]]
    """Whether to incrementally stream the response using server-sent events.

    See [streaming](https://docs.claude.com/en/api/streaming) for details.
    """


CompletionRequestStreamingMetadata = MetadataParam
"""This is deprecated, `MetadataParam` should be used instead"""

CompletionRequestNonStreamingMetadata = MetadataParam
"""This is deprecated, `MetadataParam` should be used instead"""

CompletionRequestNonStreaming = CompletionCreateParamsNonStreaming
"""This is deprecated, `CompletionCreateParamsNonStreaming` should be used instead"""

CompletionRequestStreaming = CompletionCreateParamsStreaming
"""This is deprecated, `CompletionCreateParamsStreaming` should be used instead"""

CompletionCreateParams = Union[CompletionCreateParamsNonStreaming, CompletionCreateParamsStreaming]
