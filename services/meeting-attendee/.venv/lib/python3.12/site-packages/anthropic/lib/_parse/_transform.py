from __future__ import annotations

import inspect
from typing import Any, Literal, Optional, cast
from typing_extensions import assert_never

import pydantic

from ..._utils import is_list

SupportedTypes = Literal[
    "object",
    "array",
    "string",
    "integer",
    "number",
    "boolean",
    "null",
]

SupportedStringFormats = {
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
}


def get_transformed_string(
    schema: dict[str, Any],
) -> dict[str, Any]:
    """Transforms a JSON schema of type string to ensure it conforms to the API's expectations.

    Specifically, it ensures that if the schema is of type "string" and does not already
    specify a "format", it sets the format to "text".

    Args:
        schema: The original JSON schema.

    Returns:
        The transformed JSON schema.
    """
    if schema.get("type") == "string" and "format" not in schema:
        schema["format"] = "text"
    return schema


def transform_schema(
    json_schema: type[pydantic.BaseModel] | dict[str, Any],
) -> dict[str, Any]:
    """
    Transforms a JSON schema to ensure it conforms to the API's expectations.

    Args:
        json_schema (Dict[str, Any]): The original JSON schema.

    Returns:
        The transformed JSON schema.

    Examples:
        >>> transform_schema(
        ...     {
        ...         "type": "integer",
        ...         "minimum": 1,
        ...         "maximum": 10,
        ...         "description": "A number",
        ...     }
        ... )
        {'type': 'integer', 'description': 'A number\n\n{minimum: 1, maximum: 10}'}
    """
    if inspect.isclass(json_schema) and issubclass(json_schema, pydantic.BaseModel):  # pyright: ignore[reportUnnecessaryIsInstance]
        json_schema = json_schema.model_json_schema()

    strict_schema: dict[str, Any] = {}
    json_schema = {**json_schema}

    ref = json_schema.pop("$ref", None)
    if ref is not None:
        strict_schema["$ref"] = ref
        return strict_schema

    defs = json_schema.pop("$defs", None)
    if defs is not None:
        strict_defs: dict[str, Any] = {}
        strict_schema["$defs"] = strict_defs

        for name, schema in defs.items():
            strict_defs[name] = transform_schema(schema)

    type_: Optional[SupportedTypes] = json_schema.pop("type", None)
    any_of = json_schema.pop("anyOf", None)
    one_of = json_schema.pop("oneOf", None)
    all_of = json_schema.pop("allOf", None)

    if is_list(any_of):
        strict_schema["anyOf"] = [transform_schema(cast("dict[str, Any]", variant)) for variant in any_of]
    elif is_list(one_of):
        strict_schema["anyOf"] = [transform_schema(cast("dict[str, Any]", variant)) for variant in one_of]
    elif is_list(all_of):
        strict_schema["allOf"] = [transform_schema(cast("dict[str, Any]", variant)) for variant in all_of]
    else:
        if type_ is None:
            raise ValueError("Schema must have a 'type', 'anyOf', 'oneOf', or 'allOf' field.")

        strict_schema["type"] = type_

    enum = json_schema.pop("enum", None)
    if is_list(enum):
        strict_schema["enum"] = enum

    description = json_schema.pop("description", None)
    if description is not None:
        strict_schema["description"] = description

    title = json_schema.pop("title", None)
    if title is not None:
        strict_schema["title"] = title

    if type_ == "object":
        strict_schema["properties"] = {
            key: transform_schema(prop_schema) for key, prop_schema in json_schema.pop("properties", {}).items()
        }
        json_schema.pop("additionalProperties", None)
        strict_schema["additionalProperties"] = False

        required = json_schema.pop("required", None)
        if required is not None:
            strict_schema["required"] = required

    elif type_ == "string":
        format = json_schema.pop("format", None)
        if format and format in SupportedStringFormats:
            strict_schema["format"] = format
        elif format:
            # add it back so its treated as an extra property and appended to the description
            json_schema["format"] = format
    elif type_ == "array":
        items = json_schema.pop("items", None)
        if items is not None:
            strict_schema["items"] = transform_schema(items)

        min_items = json_schema.pop("minItems", None)
        if min_items is not None and min_items == 0 or min_items == 1:
            strict_schema["minItems"] = min_items
        elif min_items is not None:
            # add it back so its treated as an extra property and appended to the description
            json_schema["minItems"] = min_items

    elif type_ == "boolean" or type_ == "integer" or type_ == "number" or type_ == "null" or type_ is None:
        pass
    else:
        assert_never(type_)

    # if there are any propes leftover then they aren't supported, so we add them to the description
    # so that the model *might* follow them.
    if json_schema:
        description = strict_schema.get("description")
        strict_schema["description"] = (
            (description + "\n\n" if description is not None else "")
            + "{"
            + ", ".join(f"{key}: {value}" for key, value in json_schema.items())
            + "}"
        )

    return strict_schema
