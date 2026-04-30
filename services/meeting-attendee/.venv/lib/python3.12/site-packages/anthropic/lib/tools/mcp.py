"""Helpers for integrating MCP (Model Context Protocol) SDK types with the Anthropic SDK.

These helpers reduce boilerplate when converting between MCP types and Anthropic API types.

Usage::

    from anthropic.lib.tools.mcp import mcp_tool, async_mcp_tool, mcp_message

This module requires the ``mcp`` package to be installed.
"""
# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportMissingImports=false, reportUnknownParameterType=false

from __future__ import annotations

import json
import base64
from typing import Any, Iterable
from urllib.parse import urlparse
from typing_extensions import Literal

try:
    from mcp.types import (  # type: ignore[import-not-found]
        Tool,
        TextContent,
        ContentBlock,
        ImageContent,
        PromptMessage,
        CallToolResult,
        EmbeddedResource,
        ReadResourceResult,
        BlobResourceContents,
        TextResourceContents,
    )
    from mcp.client.session import ClientSession  # type: ignore[import-not-found]
except ImportError as _err:
    raise ImportError(
        "The `mcp` package is required to use MCP helpers. Install it with: pip install anthropic[mcp]. Requires Python 3.10 or higher."
    ) from _err

from ...types.beta import (
    BetaBase64PDFSourceParam,
    BetaPlainTextSourceParam,
    BetaBase64ImageSourceParam,
    BetaCacheControlEphemeralParam,
)
from ._beta_functions import (
    ToolError,
    BetaFunctionTool,
    BetaAsyncFunctionTool,
    BetaFunctionToolResultType,
    beta_tool,
    beta_async_tool,
)
from .._stainless_helpers import tag_helper
from ...types.beta.beta_tool_result_block_param import Content as BetaContent

__all__ = [
    "mcp_tool",
    "async_mcp_tool",
    "mcp_content",
    "mcp_message",
    "mcp_resource_to_content",
    "mcp_resource_to_file",
    "UnsupportedMCPValueError",
]

# -----------------------------------------------------------------------
# Supported MIME types
# -----------------------------------------------------------------------

_SUPPORTED_IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/gif", "image/webp"})


class _TaggedDict(dict):  # type: ignore[type-arg]
    """A dict subclass that can carry a ``_stainless_helper`` attribute.

    Behaves identically to a regular dict for serialization and isinstance checks,
    but allows attaching tracking metadata that won't appear in JSON output.
    """


class _TaggedTuple(tuple):  # type: ignore[type-arg]
    """A tuple subclass that can carry a ``_stainless_helper`` attribute."""


def _is_supported_image_type(mime_type: str) -> bool:
    return mime_type in _SUPPORTED_IMAGE_TYPES


def _is_supported_resource_mime_type(mime_type: str | None) -> bool:
    return (
        mime_type is None
        or mime_type.startswith("text/")
        or mime_type == "application/pdf"
        or _is_supported_image_type(mime_type)
    )


# -----------------------------------------------------------------------
# Errors
# -----------------------------------------------------------------------


class UnsupportedMCPValueError(Exception):
    """Raised when an MCP value cannot be converted to a format supported by the Claude API."""


# -----------------------------------------------------------------------
# Content conversion
# -----------------------------------------------------------------------


def mcp_content(
    content: ContentBlock,
    *,
    cache_control: BetaCacheControlEphemeralParam | None = None,
) -> BetaContent:
    """Convert a single MCP content block to an Anthropic content block.

    Handles text, image, and embedded resource content types.
    Raises :class:`UnsupportedMCPValueError` for audio and resource_link types.
    """
    if isinstance(content, TextContent):
        block = _TaggedDict({"type": "text", "text": content.text})
        if cache_control is not None:
            block["cache_control"] = cache_control
        tag_helper(block, "mcp_content")
        return block  # type: ignore[return-value]

    if isinstance(content, ImageContent):
        if not _is_supported_image_type(content.mimeType):
            raise UnsupportedMCPValueError(f"Unsupported image MIME type: {content.mimeType}")
        image_block = _TaggedDict(
            {
                "type": "image",
                "source": BetaBase64ImageSourceParam(
                    type="base64",
                    data=content.data,
                    media_type=content.mimeType,  # type: ignore[typeddict-item]
                ),
            }
        )
        if cache_control is not None:
            image_block["cache_control"] = cache_control
        tag_helper(image_block, "mcp_content")
        return image_block  # type: ignore[return-value]

    if isinstance(content, EmbeddedResource):
        return _resource_contents_to_block(content.resource, cache_control=cache_control)

    # audio, resource_link, or unknown
    content_type = getattr(content, "type", type(content).__name__)
    raise UnsupportedMCPValueError(f"Unsupported MCP content type: {content_type}")


def _resource_contents_to_block(
    resource: TextResourceContents | BlobResourceContents,
    *,
    cache_control: BetaCacheControlEphemeralParam | None = None,
) -> BetaContent:
    """Convert MCP resource contents to an Anthropic content block."""
    mime_type = resource.mimeType

    # Images
    if mime_type is not None and _is_supported_image_type(mime_type):
        if not isinstance(resource, BlobResourceContents):
            raise UnsupportedMCPValueError(f"Image resource must have blob data, not text. URI: {resource.uri}")
        image_block = _TaggedDict(
            {
                "type": "image",
                "source": BetaBase64ImageSourceParam(
                    type="base64",
                    data=resource.blob,
                    media_type=mime_type,  # type: ignore[typeddict-item]
                ),
            }
        )
        if cache_control is not None:
            image_block["cache_control"] = cache_control
        tag_helper(image_block, "mcp_resource_to_content")
        return image_block  # type: ignore[return-value]

    # PDFs
    if mime_type == "application/pdf":
        if not isinstance(resource, BlobResourceContents):
            raise UnsupportedMCPValueError(f"PDF resource must have blob data, not text. URI: {resource.uri}")
        pdf_block = _TaggedDict(
            {
                "type": "document",
                "source": BetaBase64PDFSourceParam(
                    type="base64",
                    data=resource.blob,
                    media_type="application/pdf",
                ),
            }
        )
        if cache_control is not None:
            pdf_block["cache_control"] = cache_control
        tag_helper(pdf_block, "mcp_resource_to_content")
        return pdf_block  # type: ignore[return-value]

    # Text (text/*, or no MIME type)
    if mime_type is None or mime_type.startswith("text/"):
        if isinstance(resource, TextResourceContents):
            data = resource.text
        else:
            data = base64.b64decode(resource.blob).decode("utf-8")
        text_block = _TaggedDict(
            {
                "type": "document",
                "source": BetaPlainTextSourceParam(
                    type="text",
                    data=data,
                    media_type="text/plain",
                ),
            }
        )
        if cache_control is not None:
            text_block["cache_control"] = cache_control
        tag_helper(text_block, "mcp_resource_to_content")
        return text_block  # type: ignore[return-value]

    raise UnsupportedMCPValueError(f'Unsupported MIME type "{mime_type}" for resource: {resource.uri}')


# -----------------------------------------------------------------------
# Message conversion
# -----------------------------------------------------------------------


def mcp_message(
    message: PromptMessage,
    *,
    cache_control: BetaCacheControlEphemeralParam | None = None,
) -> dict[str, Any]:
    """Convert an MCP prompt message to an Anthropic ``BetaMessageParam``."""
    result = _TaggedDict(
        {
            "role": message.role,
            "content": [mcp_content(message.content, cache_control=cache_control)],
        }
    )
    tag_helper(result, "mcp_message")
    return result


# -----------------------------------------------------------------------
# Resource conversion
# -----------------------------------------------------------------------


def mcp_resource_to_content(
    result: ReadResourceResult,
    *,
    cache_control: BetaCacheControlEphemeralParam | None = None,
) -> BetaContent:
    """Convert MCP resource contents to an Anthropic content block.

    Finds the first resource with a supported MIME type from the result's
    ``contents`` list.
    """
    if not result.contents:
        raise UnsupportedMCPValueError("Resource contents array must contain at least one item")

    supported = next(
        (c for c in result.contents if _is_supported_resource_mime_type(c.mimeType)),
        None,
    )
    if supported is None:
        mime_types = [c.mimeType for c in result.contents if c.mimeType is not None]
        raise UnsupportedMCPValueError(
            f"No supported MIME type found in resource contents. Available: {', '.join(mime_types)}"
        )

    return _resource_contents_to_block(supported, cache_control=cache_control)


def mcp_resource_to_file(
    result: ReadResourceResult,
) -> tuple[str | None, bytes, str | None]:
    """Convert MCP resource contents to a file tuple for ``files.upload()``.

    Returns a ``(filename, content_bytes, mime_type)`` tuple compatible with
    the SDK's ``FileTypes``.
    """
    if not result.contents:
        raise UnsupportedMCPValueError("Resource contents array must contain at least one item")

    resource = result.contents[0]
    uri_str = str(resource.uri)

    # Extract filename from URI
    path = urlparse(uri_str).path
    name = path.rsplit("/", 1)[-1] if path else None

    # Get bytes
    if isinstance(resource, BlobResourceContents):
        content_bytes = base64.b64decode(resource.blob)
    else:
        content_bytes = resource.text.encode("utf-8")

    file_tuple = _TaggedTuple((name, content_bytes, resource.mimeType))
    tag_helper(file_tuple, "mcp_resource_to_file")
    return file_tuple


# -----------------------------------------------------------------------
# Tool result conversion (used by tool call handlers)
# -----------------------------------------------------------------------


def _convert_tool_result(result: CallToolResult) -> BetaFunctionToolResultType:
    """Convert MCP ``CallToolResult`` to a value suitable for returning from ``call()``."""
    if result.isError:
        raise ToolError([mcp_content(item) for item in result.content])

    # If content is empty but structuredContent is present, JSON-encode it
    if not result.content and result.structuredContent is not None:
        return json.dumps(result.structuredContent)

    return [mcp_content(item) for item in result.content]


# -----------------------------------------------------------------------
# Public factory functions
# -----------------------------------------------------------------------


def mcp_tool(
    tool: Tool,
    client: ClientSession,
    *,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    defer_loading: bool | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> BetaFunctionTool[Any]:
    """Convert an MCP tool to a sync runnable tool for ``tool_runner()``.

    Example::

        from anthropic.lib.tools.mcp import mcp_tool

        tools_result = await mcp_client.list_tools()
        runner = client.beta.messages.tool_runner(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            tools=[mcp_tool(t, mcp_client) for t in tools_result.tools],
            messages=[{"role": "user", "content": "Use the available tools"}],
        )

    Args:
        tool: An MCP tool definition from ``client.list_tools()``.
        client: The MCP ``ClientSession`` used to call the tool.
        cache_control: Cache control configuration.
        defer_loading: If true, tool will not be included in initial system prompt.
        allowed_callers: Which callers may use this tool.
        eager_input_streaming: Enable eager input streaming for this tool.
        input_examples: Example inputs for the tool.
        strict: When true, guarantees schema validation on tool names and inputs.
    """
    import anyio.from_thread

    tool_name = tool.name

    def call_mcp(**kwargs: Any) -> BetaFunctionToolResultType:
        result = anyio.from_thread.run(client.call_tool, tool_name, kwargs)
        return _convert_tool_result(result)

    result = beta_tool(
        call_mcp,
        name=tool_name,
        description=tool.description,
        input_schema=tool.inputSchema,
        cache_control=cache_control,
        defer_loading=defer_loading,
        allowed_callers=allowed_callers,
        eager_input_streaming=eager_input_streaming,
        input_examples=input_examples,
        strict=strict,
    )
    tag_helper(result, "mcp_tool")
    return result


def async_mcp_tool(
    tool: Tool,
    client: ClientSession,
    *,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    defer_loading: bool | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> BetaAsyncFunctionTool[Any]:
    """Convert an MCP tool to an async runnable tool for ``tool_runner()``.

    Example::

        from anthropic.lib.tools.mcp import async_mcp_tool

        tools_result = await mcp_client.list_tools()
        runner = await client.beta.messages.tool_runner(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            tools=[async_mcp_tool(t, mcp_client) for t in tools_result.tools],
            messages=[{"role": "user", "content": "Use the available tools"}],
        )

    Args:
        tool: An MCP tool definition from ``client.list_tools()``.
        client: The MCP ``ClientSession`` used to call the tool.
        cache_control: Cache control configuration.
        defer_loading: If true, tool will not be included in initial system prompt.
        allowed_callers: Which callers may use this tool.
        eager_input_streaming: Enable eager input streaming for this tool.
        input_examples: Example inputs for the tool.
        strict: When true, guarantees schema validation on tool names and inputs.
    """
    tool_name = tool.name

    async def call_mcp(**kwargs: Any) -> BetaFunctionToolResultType:
        result = await client.call_tool(name=tool_name, arguments=kwargs)
        return _convert_tool_result(result)

    result = beta_async_tool(
        call_mcp,
        name=tool_name,
        description=tool.description,
        input_schema=tool.inputSchema,
        cache_control=cache_control,
        defer_loading=defer_loading,
        allowed_callers=allowed_callers,
        eager_input_streaming=eager_input_streaming,
        input_examples=input_examples,
        strict=strict,
    )
    tag_helper(result, "mcp_tool")
    return result
