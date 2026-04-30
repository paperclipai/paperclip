"""Tracking for SDK helper usage via the x-stainless-helper header."""

from __future__ import annotations

from typing import Any, Dict, cast

_HELPER_ATTR = "_stainless_helper"


def tag_helper(obj: Any, name: str) -> None:
    """Mark an object as created by a named SDK helper."""
    try:
        object.__setattr__(obj, _HELPER_ATTR, name)
    except (AttributeError, TypeError):
        pass


def get_helper_tag(obj: object) -> str | None:
    """Get the helper name from an object, if any."""
    return getattr(obj, _HELPER_ATTR, None)  # type: ignore[return-value]


def collect_helpers(
    tools: Any = None,
    messages: Any = None,
) -> list[str]:
    """Collect deduplicated helper names from tools and messages."""
    helpers: set[str] = set()

    if tools:
        for tool in tools:
            tag = get_helper_tag(tool)
            if tag is not None:
                helpers.add(tag)

    if messages:
        for message in messages:
            tag = get_helper_tag(message)
            if tag is not None:
                helpers.add(tag)

            # Check content blocks within messages
            if isinstance(message, dict):
                blocks: Any = cast(Dict[str, Any], message).get("content")
            else:
                blocks = getattr(message, "content", None)
            if isinstance(blocks, list):
                for block in cast(list[object], blocks):
                    tag = get_helper_tag(block)
                    if tag is not None:
                        helpers.add(tag)

    return list(helpers)


def stainless_helper_header(
    tools: Any = None,
    messages: Any = None,
) -> dict[str, str]:
    """Build x-stainless-helper header dict from tools and messages.

    Returns an empty dict if no helpers are found.
    """
    helpers = collect_helpers(tools, messages)
    if not helpers:
        return {}
    return {"x-stainless-helper": ", ".join(helpers)}


def stainless_helper_header_from_file(file: object) -> dict[str, str]:
    """Build x-stainless-helper header dict from a file object."""
    tag = get_helper_tag(file)
    if tag is None:
        return {}
    return {"x-stainless-helper": tag}
