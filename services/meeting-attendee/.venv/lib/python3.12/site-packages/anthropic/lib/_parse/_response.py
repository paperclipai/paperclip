from __future__ import annotations

from typing_extensions import TypeVar

from ..._types import NotGiven
from ..._models import TypeAdapter, construct_type_unchecked
from ..._utils._utils import is_given
from ...types.message import Message
from ...types.parsed_message import ParsedMessage, ParsedTextBlock, ParsedContentBlock
from ...types.beta.beta_message import BetaMessage
from ...types.beta.parsed_beta_message import ParsedBetaMessage, ParsedBetaTextBlock, ParsedBetaContentBlock

ResponseFormatT = TypeVar("ResponseFormatT", default=None)


def parse_text(text: str, output_format: ResponseFormatT | NotGiven) -> ResponseFormatT | None:
    if is_given(output_format):
        adapted_type: TypeAdapter[ResponseFormatT] = TypeAdapter(output_format)
        return adapted_type.validate_json(text)
    return None


def parse_beta_response(
    *,
    output_format: ResponseFormatT | NotGiven,
    response: BetaMessage,
) -> ParsedBetaMessage[ResponseFormatT]:
    content_list: list[ParsedBetaContentBlock[ResponseFormatT]] = []
    for content in response.content:
        if content.type == "text":
            content_list.append(
                construct_type_unchecked(
                    type_=ParsedBetaTextBlock[ResponseFormatT],
                    value={**content.to_dict(), "parsed_output": parse_text(content.text, output_format)},
                )
            )
        else:
            content_list.append(content)  # type: ignore

    return construct_type_unchecked(
        type_=ParsedBetaMessage[ResponseFormatT],
        value={
            **response.to_dict(),
            "content": content_list,
        },
    )


def parse_response(
    *,
    output_format: ResponseFormatT | NotGiven,
    response: Message,
) -> ParsedMessage[ResponseFormatT]:
    content_list: list[ParsedContentBlock[ResponseFormatT]] = []
    for content in response.content:
        if content.type == "text":
            content_list.append(
                construct_type_unchecked(
                    type_=ParsedTextBlock[ResponseFormatT],
                    value={**content.to_dict(), "parsed_output": parse_text(content.text, output_format)},
                )
            )
        else:
            content_list.append(content)  # type: ignore

    return construct_type_unchecked(
        type_=ParsedMessage[ResponseFormatT],
        value={
            **response.to_dict(),
            "content": content_list,
        },
    )
