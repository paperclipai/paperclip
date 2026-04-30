from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any, Union, Generic, TypeVar, Callable, Iterable, Coroutine, cast, overload
from inspect import iscoroutinefunction
from typing_extensions import Literal, TypeAlias, override

import pydantic
import docstring_parser
from pydantic import BaseModel

from ... import _compat
from ..._utils import is_dict
from ..._compat import cached_property
from ..._models import TypeAdapter
from ...types.beta import BetaToolParam, BetaToolUnionParam, BetaCacheControlEphemeralParam
from ..._utils._utils import CallableT
from ...types.tool_param import InputSchema
from ...types.beta.beta_tool_result_block_param import Content as BetaContent

log = logging.getLogger(__name__)

BetaFunctionToolResultType: TypeAlias = Union[str, Iterable[BetaContent]]


class ToolError(Exception):
    """Error that can be raised from a tool to return structured content with ``is_error: True``.

    When the tool runner catches this error, it will use the :attr:`content`
    property as the tool result instead of ``repr(exc)``.

    Example::

        raise ToolError(
            [
                {"type": "text", "text": "Error details here"},
                {"type": "image", "source": {"type": "base64", "data": "...", "media_type": "image/png"}},
            ]
        )
    """

    content: BetaFunctionToolResultType

    def __init__(self, content: BetaFunctionToolResultType) -> None:
        if isinstance(content, str):
            message = content
        else:
            parts: list[str] = []
            for block in content:
                text = block.get("text")
                if text is not None:
                    parts.append(str(text))
                else:
                    parts.append(f"[{block.get('type', 'unknown')}]")
            message = " ".join(parts) if parts else "Tool error"
        super().__init__(message)
        self.content = content


Function = Callable[..., BetaFunctionToolResultType]
FunctionT = TypeVar("FunctionT", bound=Function)

AsyncFunction = Callable[..., Coroutine[Any, Any, BetaFunctionToolResultType]]
AsyncFunctionT = TypeVar("AsyncFunctionT", bound=AsyncFunction)


class BetaBuiltinFunctionTool(ABC):
    @abstractmethod
    def to_dict(self) -> BetaToolUnionParam: ...

    @abstractmethod
    def call(self, input: object) -> BetaFunctionToolResultType: ...

    @property
    def name(self) -> str:
        raw = self.to_dict()
        if "mcp_server_name" in raw:
            return raw["mcp_server_name"]
        return raw["name"]


class BetaAsyncBuiltinFunctionTool(ABC):
    @abstractmethod
    def to_dict(self) -> BetaToolUnionParam: ...

    @abstractmethod
    async def call(self, input: object) -> BetaFunctionToolResultType: ...

    @property
    def name(self) -> str:
        raw = self.to_dict()
        if "mcp_server_name" in raw:
            return raw["mcp_server_name"]
        return raw["name"]


class BaseFunctionTool(Generic[CallableT]):
    func: CallableT
    """The function this tool is wrapping"""

    name: str
    """The name of the tool that will be sent to the API"""

    description: str

    input_schema: InputSchema

    def __init__(
        self,
        func: CallableT,
        *,
        name: str | None = None,
        description: str | None = None,
        input_schema: InputSchema | type[BaseModel] | None = None,
        defer_loading: bool | None = None,
        cache_control: BetaCacheControlEphemeralParam | None = None,
        allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
        eager_input_streaming: bool | None = None,
        input_examples: Iterable[dict[str, object]] | None = None,
        strict: bool | None = None,
    ) -> None:
        if _compat.PYDANTIC_V1:
            raise RuntimeError("Tool functions are only supported with Pydantic v2")

        self.func = func
        self._func_with_validate = pydantic.validate_call(func)
        self.name = name or func.__name__
        self._defer_loading = defer_loading
        self._cache_control = cache_control
        self._allowed_callers = allowed_callers
        self._eager_input_streaming = eager_input_streaming
        self._input_examples = input_examples
        self._strict = strict

        self.description = description or self._get_description_from_docstring()

        if input_schema is not None:
            if isinstance(input_schema, type):
                self.input_schema: InputSchema = input_schema.model_json_schema()
            else:
                self.input_schema = input_schema
        else:
            self.input_schema = self._create_schema_from_function()

    @property
    def __call__(self) -> CallableT:
        return self.func

    def to_dict(self) -> BetaToolParam:
        defn: BetaToolParam = {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }
        if self._defer_loading is not None:
            defn["defer_loading"] = self._defer_loading
        if self._cache_control is not None:
            defn["cache_control"] = self._cache_control
        if self._allowed_callers is not None:
            defn["allowed_callers"] = self._allowed_callers
        if self._eager_input_streaming is not None:
            defn["eager_input_streaming"] = self._eager_input_streaming
        if self._input_examples is not None:
            defn["input_examples"] = self._input_examples
        if self._strict is not None:
            defn["strict"] = self._strict
        return defn

    @cached_property
    def _parsed_docstring(self) -> docstring_parser.Docstring:
        return docstring_parser.parse(self.func.__doc__ or "")

    def _get_description_from_docstring(self) -> str:
        """Extract description from parsed docstring."""
        if self._parsed_docstring.short_description:
            description = self._parsed_docstring.short_description
            if self._parsed_docstring.long_description:
                description += f"\n\n{self._parsed_docstring.long_description}"
            return description
        return ""

    def _create_schema_from_function(self) -> InputSchema:
        """Create JSON schema from function signature using pydantic."""

        from pydantic_core import CoreSchema
        from pydantic.json_schema import JsonSchemaValue, GenerateJsonSchema
        from pydantic_core.core_schema import ArgumentsParameter

        class CustomGenerateJsonSchema(GenerateJsonSchema):
            def __init__(self, *, func: Callable[..., Any], parsed_docstring: Any) -> None:
                super().__init__()
                self._func = func
                self._parsed_docstring = parsed_docstring

            def __call__(self, *_args: Any, **_kwds: Any) -> "CustomGenerateJsonSchema":  # noqa: ARG002
                return self

            @override
            def kw_arguments_schema(
                self,
                arguments: "list[ArgumentsParameter]",
                var_kwargs_schema: CoreSchema | None,
            ) -> JsonSchemaValue:
                schema = super().kw_arguments_schema(arguments, var_kwargs_schema)
                if schema.get("type") != "object":
                    return schema

                properties = schema.get("properties")
                if not properties or not is_dict(properties):
                    return schema

                # Add parameter descriptions from docstring
                for param in self._parsed_docstring.params:
                    prop_schema = properties.get(param.arg_name)
                    if not prop_schema or not is_dict(prop_schema):
                        continue

                    if param.description and "description" not in prop_schema:
                        prop_schema["description"] = param.description

                return schema

        schema_generator = CustomGenerateJsonSchema(func=self.func, parsed_docstring=self._parsed_docstring)
        return self._adapter.json_schema(schema_generator=schema_generator)  # type: ignore

    @cached_property
    def _adapter(self) -> TypeAdapter[Any]:
        return TypeAdapter(self._func_with_validate)


class BetaFunctionTool(BaseFunctionTool[FunctionT]):
    def call(self, input: object) -> BetaFunctionToolResultType:
        if iscoroutinefunction(self.func):
            raise RuntimeError("Cannot call a coroutine function synchronously. Use `@async_tool` instead.")

        if not is_dict(input):
            raise TypeError(f"Input must be a dictionary, got {type(input).__name__}")

        try:
            return self._func_with_validate(**cast(Any, input))
        except pydantic.ValidationError as e:
            raise ValueError(f"Invalid arguments for function {self.name}") from e


class BetaAsyncFunctionTool(BaseFunctionTool[AsyncFunctionT]):
    async def call(self, input: object) -> BetaFunctionToolResultType:
        if not iscoroutinefunction(self.func):
            raise RuntimeError("Cannot call a synchronous function asynchronously. Use `@tool` instead.")

        if not is_dict(input):
            raise TypeError(f"Input must be a dictionary, got {type(input).__name__}")

        try:
            return await self._func_with_validate(**cast(Any, input))
        except pydantic.ValidationError as e:
            raise ValueError(f"Invalid arguments for function {self.name}") from e


@overload
def beta_tool(func: FunctionT) -> BetaFunctionTool[FunctionT]: ...


@overload
def beta_tool(
    func: FunctionT,
    *,
    name: str | None = None,
    description: str | None = None,
    input_schema: InputSchema | type[BaseModel] | None = None,
    defer_loading: bool | None = None,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> BetaFunctionTool[FunctionT]: ...


@overload
def beta_tool(
    *,
    name: str | None = None,
    description: str | None = None,
    input_schema: InputSchema | type[BaseModel] | None = None,
    defer_loading: bool | None = None,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> Callable[[FunctionT], BetaFunctionTool[FunctionT]]: ...


def beta_tool(
    func: FunctionT | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    input_schema: InputSchema | type[BaseModel] | None = None,
    defer_loading: bool | None = None,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> BetaFunctionTool[FunctionT] | Callable[[FunctionT], BetaFunctionTool[FunctionT]]:
    """Create a FunctionTool from a function with automatic schema inference.

    Can be used as a decorator with or without parentheses:

    @function_tool
    def my_func(x: int) -> str: ...

    @function_tool()
    def my_func(x: int) -> str: ...

    @function_tool(name="custom_name")
    def my_func(x: int) -> str: ...
    """
    if _compat.PYDANTIC_V1:
        raise RuntimeError("Tool functions are only supported with Pydantic v2")

    def _make(fn: FunctionT) -> BetaFunctionTool[FunctionT]:
        return BetaFunctionTool(
            fn,
            name=name,
            description=description,
            input_schema=input_schema,
            defer_loading=defer_loading,
            cache_control=cache_control,
            allowed_callers=allowed_callers,
            eager_input_streaming=eager_input_streaming,
            input_examples=input_examples,
            strict=strict,
        )

    if func is not None:
        return _make(func)

    return _make


@overload
def beta_async_tool(func: AsyncFunctionT) -> BetaAsyncFunctionTool[AsyncFunctionT]: ...


@overload
def beta_async_tool(
    func: AsyncFunctionT,
    *,
    name: str | None = None,
    description: str | None = None,
    input_schema: InputSchema | type[BaseModel] | None = None,
    defer_loading: bool | None = None,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> BetaAsyncFunctionTool[AsyncFunctionT]: ...  # noqa: E501


@overload
def beta_async_tool(
    *,
    name: str | None = None,
    description: str | None = None,
    input_schema: InputSchema | type[BaseModel] | None = None,
    defer_loading: bool | None = None,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> Callable[[AsyncFunctionT], BetaAsyncFunctionTool[AsyncFunctionT]]: ...


def beta_async_tool(
    func: AsyncFunctionT | None = None,
    *,
    name: str | None = None,
    description: str | None = None,
    input_schema: InputSchema | type[BaseModel] | None = None,
    defer_loading: bool | None = None,
    cache_control: BetaCacheControlEphemeralParam | None = None,
    allowed_callers: list[Literal["direct", "code_execution_20250825", "code_execution_20260120"]] | None = None,
    eager_input_streaming: bool | None = None,
    input_examples: Iterable[dict[str, object]] | None = None,
    strict: bool | None = None,
) -> BetaAsyncFunctionTool[AsyncFunctionT] | Callable[[AsyncFunctionT], BetaAsyncFunctionTool[AsyncFunctionT]]:
    """Create an AsyncFunctionTool from a function with automatic schema inference.

    Can be used as a decorator with or without parentheses:

    @async_tool
    async def my_func(x: int) -> str: ...

    @async_tool()
    async def my_func(x: int) -> str: ...

    @async_tool(name="custom_name")
    async def my_func(x: int) -> str: ...
    """
    if _compat.PYDANTIC_V1:
        raise RuntimeError("Tool functions are only supported with Pydantic v2")

    def _make(fn: AsyncFunctionT) -> BetaAsyncFunctionTool[AsyncFunctionT]:
        return BetaAsyncFunctionTool(
            fn,
            name=name,
            description=description,
            input_schema=input_schema,
            defer_loading=defer_loading,
            cache_control=cache_control,
            allowed_callers=allowed_callers,
            eager_input_streaming=eager_input_streaming,
            input_examples=input_examples,
            strict=strict,
        )

    if func is not None:
        return _make(func)

    return _make


BetaRunnableTool = Union[BetaFunctionTool[Any], BetaBuiltinFunctionTool]
BetaAsyncRunnableTool = Union[BetaAsyncFunctionTool[Any], BetaAsyncBuiltinFunctionTool]
