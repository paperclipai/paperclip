from __future__ import annotations

import logging
import warnings
from abc import ABC, abstractmethod
from typing import (
    TYPE_CHECKING,
    Any,
    List,
    Union,
    Generic,
    TypeVar,
    Callable,
    Iterable,
    Iterator,
    Coroutine,
    AsyncIterator,
)
from contextlib import contextmanager, asynccontextmanager
from typing_extensions import TypedDict, override

import httpx

from ..._types import Body, Query, Headers, NotGiven
from ..._utils import consume_sync_iterator, consume_async_iterator
from ...types.beta import BetaMessage, BetaMessageParam
from ._beta_functions import (
    ToolError,
    BetaFunctionTool,
    BetaRunnableTool,
    BetaAsyncFunctionTool,
    BetaAsyncRunnableTool,
    BetaBuiltinFunctionTool,
    BetaAsyncBuiltinFunctionTool,
)
from .._stainless_helpers import stainless_helper_header
from ._beta_compaction_control import DEFAULT_THRESHOLD, DEFAULT_SUMMARY_PROMPT, CompactionControl
from ..streaming._beta_messages import BetaMessageStream, BetaAsyncMessageStream
from ...types.beta.parsed_beta_message import ResponseFormatT, ParsedBetaMessage, ParsedBetaContentBlock
from ...types.beta.message_create_params import ParseMessageCreateParamsBase
from ...types.beta.beta_tool_result_block_param import BetaToolResultBlockParam

if TYPE_CHECKING:
    from ..._client import Anthropic, AsyncAnthropic


AnyFunctionToolT = TypeVar(
    "AnyFunctionToolT",
    bound=Union[
        BetaFunctionTool[Any], BetaAsyncFunctionTool[Any], BetaBuiltinFunctionTool, BetaAsyncBuiltinFunctionTool
    ],
)
RunnerItemT = TypeVar("RunnerItemT")

log = logging.getLogger(__name__)


class RequestOptions(TypedDict, total=False):
    extra_headers: Headers | None
    extra_query: Query | None
    extra_body: Body | None
    timeout: float | httpx.Timeout | None | NotGiven


class BaseToolRunner(Generic[AnyFunctionToolT, ResponseFormatT]):
    def __init__(
        self,
        *,
        params: ParseMessageCreateParamsBase[ResponseFormatT],
        options: RequestOptions,
        tools: Iterable[AnyFunctionToolT],
        max_iterations: int | None = None,
        compaction_control: CompactionControl | None = None,
    ) -> None:
        self._tools_by_name = {tool.name: tool for tool in tools}
        self._params: ParseMessageCreateParamsBase[ResponseFormatT] = {
            **params,
            "messages": [message for message in params["messages"]],
        }
        helper_header = stainless_helper_header(
            tools=self._tools_by_name.values(),
            messages=params.get("messages"),
        )
        if helper_header:
            merged_headers = {**helper_header, **(options.get("extra_headers") or {})}
            options = {**options, "extra_headers": merged_headers}
        self._options = options
        self._messages_modified = False
        self._cached_tool_call_response: BetaMessageParam | None = None
        self._max_iterations = max_iterations
        self._iteration_count = 0
        self._compaction_control = compaction_control

    def set_messages_params(
        self,
        params: ParseMessageCreateParamsBase[ResponseFormatT]
        | Callable[[ParseMessageCreateParamsBase[ResponseFormatT]], ParseMessageCreateParamsBase[ResponseFormatT]],
    ) -> None:
        """
        Update the parameters for the next API call. This invalidates any cached tool responses.

        Args:
            params (ParsedMessageCreateParamsBase[ResponseFormatT] | Callable): Either new parameters or a function to mutate existing parameters
        """
        if callable(params):
            params = params(self._params)
        self._params = params

    def append_messages(self, *messages: BetaMessageParam | ParsedBetaMessage[ResponseFormatT]) -> None:
        """Add one or more messages to the conversation history.

        This invalidates the cached tool response, i.e. if tools were already called, then they will
        be called again on the next loop iteration.
        """
        message_params: List[BetaMessageParam] = [
            {"role": message.role, "content": message.content} if isinstance(message, BetaMessage) else message
            for message in messages
        ]
        self._messages_modified = True
        self.set_messages_params(lambda params: {**params, "messages": [*params["messages"], *message_params]})
        self._cached_tool_call_response = None

    def _should_stop(self) -> bool:
        if self._max_iterations is not None and self._iteration_count >= self._max_iterations:
            return True
        return False


class BaseSyncToolRunner(BaseToolRunner[BetaRunnableTool, ResponseFormatT], Generic[RunnerItemT, ResponseFormatT], ABC):
    def __init__(
        self,
        *,
        params: ParseMessageCreateParamsBase[ResponseFormatT],
        options: RequestOptions,
        tools: Iterable[BetaRunnableTool],
        client: Anthropic,
        max_iterations: int | None = None,
        compaction_control: CompactionControl | None = None,
    ) -> None:
        super().__init__(
            params=params,
            options=options,
            tools=tools,
            max_iterations=max_iterations,
            compaction_control=compaction_control,
        )
        self._client = client

        if compaction_control is not None and compaction_control.get("enabled"):
            warnings.warn(
                "The 'compaction_control' parameter is deprecated and will be removed in a future version. "
                "Use server-side compaction instead by passing `edits=[{'type': 'compact_20260112'}]` in your "
                "the params passed to `tool_runner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction",
                DeprecationWarning,
                stacklevel=3,
            )

        self._iterator = self.__run__()
        self._last_message: (
            Callable[[], ParsedBetaMessage[ResponseFormatT]] | ParsedBetaMessage[ResponseFormatT] | None
        ) = None

    def __next__(self) -> RunnerItemT:
        return self._iterator.__next__()

    def __iter__(self) -> Iterator[RunnerItemT]:
        for item in self._iterator:
            yield item

    @abstractmethod
    @contextmanager
    def _handle_request(self) -> Iterator[RunnerItemT]:
        raise NotImplementedError()
        yield  # type: ignore[unreachable]

    def _check_and_compact(self) -> bool:
        """
        Check token usage and compact messages if threshold exceeded.
        Returns True if compaction was performed, False otherwise.
        """
        if self._compaction_control is None or not self._compaction_control["enabled"]:
            return False

        message = self._get_last_message()
        tokens_used = 0
        if message is not None:
            total_input_tokens = (
                message.usage.input_tokens
                + (message.usage.cache_creation_input_tokens or 0)
                + (message.usage.cache_read_input_tokens or 0)
            )
            tokens_used = total_input_tokens + message.usage.output_tokens

        threshold = self._compaction_control.get("context_token_threshold", DEFAULT_THRESHOLD)

        if tokens_used < threshold:
            return False

        # Perform compaction
        log.info(f"Token usage {tokens_used} has exceeded the threshold of {threshold}. Performing compaction.")

        model = self._compaction_control.get("model", self._params["model"])

        messages = list(self._params["messages"])

        if messages[-1]["role"] == "assistant":
            # Remove tool_use blocks from the last message to avoid 400 error
            # (tool_use requires tool_result, which we don't have yet)
            non_tool_blocks = [
                block
                for block in messages[-1]["content"]
                if isinstance(block, dict) and block.get("type") != "tool_use"
            ]

            if non_tool_blocks:
                messages[-1]["content"] = non_tool_blocks
            else:
                messages.pop()

        messages = [
            *messages,
            BetaMessageParam(
                role="user",
                content=self._compaction_control.get("summary_prompt", DEFAULT_SUMMARY_PROMPT),
            ),
        ]

        response = self._client.beta.messages.create(
            model=model,
            messages=messages,
            max_tokens=self._params["max_tokens"],
            extra_headers={"X-Stainless-Helper": "compaction"},
        )

        log.info(f"Compaction complete. New token usage: {response.usage.output_tokens}")

        first_content = list(response.content)[0]

        if first_content.type != "text":
            raise ValueError("Compaction response content is not of type 'text'")

        self.set_messages_params(
            lambda params: {
                **params,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": first_content.text,
                            }
                        ],
                    }
                ],
            }
        )
        return True

    def __run__(self) -> Iterator[RunnerItemT]:
        while not self._should_stop():
            with self._handle_request() as item:
                yield item
                message = self._get_last_message()
                assert message is not None

                # Update container from response for programmatic tool calling support
                last_assistant_message = self._get_last_assistant_message()
                if last_assistant_message is not None and last_assistant_message.container is not None:
                    self._params["container"] = last_assistant_message.container.id

            self._iteration_count += 1

            # If the compaction was performed, skip tool call generation this iteration
            if not self._check_and_compact():
                response = self.generate_tool_call_response()
                if response is None:
                    log.debug("Tool call was not requested, exiting from tool runner loop.")
                    return

                if not self._messages_modified:
                    self.append_messages(message, response)

            self._messages_modified = False
            self._cached_tool_call_response = None

    def until_done(self) -> ParsedBetaMessage[ResponseFormatT]:
        """
        Consumes the tool runner stream and returns the last message if it has not been consumed yet.
        If it has, it simply returns the last message.
        """
        consume_sync_iterator(self)
        last_message = self._get_last_message()
        assert last_message is not None
        return last_message

    def generate_tool_call_response(self) -> BetaMessageParam | None:
        """Generate a MessageParam by calling tool functions with any tool use blocks from the last message.

        Note the tool call response is cached, repeated calls to this method will return the same response.

        None can be returned if no tool call was applicable.
        """
        if self._cached_tool_call_response is not None:
            log.debug("Returning cached tool call response.")
            return self._cached_tool_call_response
        response = self._generate_tool_call_response()
        self._cached_tool_call_response = response
        return response

    def _generate_tool_call_response(self) -> BetaMessageParam | None:
        content = self._get_last_assistant_message_content()
        if not content:
            return None

        tool_use_blocks = [block for block in content if block.type == "tool_use"]
        if not tool_use_blocks:
            return None

        results: list[BetaToolResultBlockParam] = []

        for tool_use in tool_use_blocks:
            tool = self._tools_by_name.get(tool_use.name)
            if tool is None:
                warnings.warn(
                    f"Tool '{tool_use.name}' not found in tool runner. "
                    f"Available tools: {list(self._tools_by_name.keys())}. "
                    f"If using a raw tool definition, handle the tool call manually and use `append_messages()` to add the result. "
                    f"Otherwise, pass the tool using `beta_tool(func)` or a `@beta_tool` decorated function.",
                    UserWarning,
                    stacklevel=3,
                )
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": f"Error: Tool '{tool_use.name}' not found",
                        "is_error": True,
                    }
                )
                continue

            try:
                result = tool.call(tool_use.input)
                results.append({"type": "tool_result", "tool_use_id": tool_use.id, "content": result})
            except ToolError as exc:
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": exc.content,
                        "is_error": True,
                    }
                )
            except Exception as exc:
                log.exception(f"Error occurred while calling tool: {tool.name}", exc_info=exc)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": repr(exc),
                        "is_error": True,
                    }
                )

        return {"role": "user", "content": results}

    def _get_last_message(self) -> ParsedBetaMessage[ResponseFormatT] | None:
        if callable(self._last_message):
            return self._last_message()
        return self._last_message

    def _get_last_assistant_message(self) -> ParsedBetaMessage[ResponseFormatT] | None:
        last_message = self._get_last_message()
        if last_message is None or last_message.role != "assistant" or not last_message.content:
            return None

        return last_message

    def _get_last_assistant_message_content(self) -> list[ParsedBetaContentBlock[ResponseFormatT]] | None:
        last_assistant_message = self._get_last_assistant_message()
        if last_assistant_message is None:
            return None

        return last_assistant_message.content


class BetaToolRunner(BaseSyncToolRunner[ParsedBetaMessage[ResponseFormatT], ResponseFormatT]):
    @override
    @contextmanager
    def _handle_request(self) -> Iterator[ParsedBetaMessage[ResponseFormatT]]:
        message = self._client.beta.messages.parse(**self._params, **self._options)
        self._last_message = message
        yield message


class BetaStreamingToolRunner(BaseSyncToolRunner[BetaMessageStream[ResponseFormatT], ResponseFormatT]):
    @override
    @contextmanager
    def _handle_request(self) -> Iterator[BetaMessageStream[ResponseFormatT]]:
        with self._client.beta.messages.stream(**self._params, **self._options) as stream:
            self._last_message = stream.get_final_message
            yield stream


class BaseAsyncToolRunner(
    BaseToolRunner[BetaAsyncRunnableTool, ResponseFormatT], Generic[RunnerItemT, ResponseFormatT], ABC
):
    def __init__(
        self,
        *,
        params: ParseMessageCreateParamsBase[ResponseFormatT],
        options: RequestOptions,
        tools: Iterable[BetaAsyncRunnableTool],
        client: AsyncAnthropic,
        max_iterations: int | None = None,
        compaction_control: CompactionControl | None = None,
    ) -> None:
        super().__init__(
            params=params,
            options=options,
            tools=tools,
            max_iterations=max_iterations,
            compaction_control=compaction_control,
        )
        self._client = client

        if compaction_control is not None and compaction_control.get("enabled"):
            warnings.warn(
                "The 'compaction_control' parameter is deprecated and will be removed in a future version. "
                "Use server-side compaction instead by passing `edits=[{'type': 'compact_20260112'}]` in your "
                "the params passed to `tool_runner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction",
                DeprecationWarning,
                stacklevel=3,
            )

        self._iterator = self.__run__()
        self._last_message: (
            Callable[[], Coroutine[None, None, ParsedBetaMessage[ResponseFormatT]]]
            | ParsedBetaMessage[ResponseFormatT]
            | None
        ) = None

    async def __anext__(self) -> RunnerItemT:
        return await self._iterator.__anext__()

    async def __aiter__(self) -> AsyncIterator[RunnerItemT]:
        async for item in self._iterator:
            yield item

    @abstractmethod
    @asynccontextmanager
    async def _handle_request(self) -> AsyncIterator[RunnerItemT]:
        raise NotImplementedError()
        yield  # type: ignore[unreachable]

    async def _check_and_compact(self) -> bool:
        """
        Check token usage and compact messages if threshold exceeded.
        Returns True if compaction was performed, False otherwise.
        """
        if self._compaction_control is None or not self._compaction_control["enabled"]:
            return False

        message = await self._get_last_message()
        tokens_used = 0
        if message is not None:
            total_input_tokens = (
                message.usage.input_tokens
                + (message.usage.cache_creation_input_tokens or 0)
                + (message.usage.cache_read_input_tokens or 0)
            )
            tokens_used = total_input_tokens + message.usage.output_tokens

        threshold = self._compaction_control.get("context_token_threshold", DEFAULT_THRESHOLD)

        if tokens_used < threshold:
            return False

        # Perform compaction
        log.info(f"Token usage {tokens_used} has exceeded the threshold of {threshold}. Performing compaction.")

        model = self._compaction_control.get("model", self._params["model"])

        messages = list(self._params["messages"])

        if messages[-1]["role"] == "assistant":
            # Remove tool_use blocks from the last message to avoid 400 error
            # (tool_use requires tool_result, which we don't have yet)
            non_tool_blocks = [
                block
                for block in messages[-1]["content"]
                if isinstance(block, dict) and block.get("type") != "tool_use"
            ]

            if non_tool_blocks:
                messages[-1]["content"] = non_tool_blocks
            else:
                messages.pop()

        messages = [
            *messages,
            BetaMessageParam(
                role="user",
                content=self._compaction_control.get("summary_prompt", DEFAULT_SUMMARY_PROMPT),
            ),
        ]

        response = await self._client.beta.messages.create(
            model=model,
            messages=messages,
            max_tokens=self._params["max_tokens"],
            extra_headers={"X-Stainless-Helper": "compaction"},
        )

        log.info(f"Compaction complete. New token usage: {response.usage.output_tokens}")

        first_content = list(response.content)[0]

        if first_content.type != "text":
            raise ValueError("Compaction response content is not of type 'text'")

        self.set_messages_params(
            lambda params: {
                **params,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": first_content.text,
                            }
                        ],
                    }
                ],
            }
        )
        return True

    async def __run__(self) -> AsyncIterator[RunnerItemT]:
        while not self._should_stop():
            async with self._handle_request() as item:
                yield item
                message = await self._get_last_message()
                assert message is not None

                # Update container from response for programmatic tool calling support
                last_assistant_message = await self._get_last_assistant_message()
                if last_assistant_message is not None and last_assistant_message.container is not None:
                    self._params["container"] = last_assistant_message.container.id

            self._iteration_count += 1

            # If the compaction was performed, skip tool call generation this iteration
            if not await self._check_and_compact():
                response = await self.generate_tool_call_response()
                if response is None:
                    log.debug("Tool call was not requested, exiting from tool runner loop.")
                    return

                if not self._messages_modified:
                    self.append_messages(message, response)

            self._messages_modified = False
            self._cached_tool_call_response = None

    async def until_done(self) -> ParsedBetaMessage[ResponseFormatT]:
        """
        Consumes the tool runner stream and returns the last message if it has not been consumed yet.
        If it has, it simply returns the last message.
        """
        await consume_async_iterator(self)
        last_message = await self._get_last_message()
        assert last_message is not None
        return last_message

    async def generate_tool_call_response(self) -> BetaMessageParam | None:
        """Generate a MessageParam by calling tool functions with any tool use blocks from the last message.

        Note the tool call response is cached, repeated calls to this method will return the same response.

        None can be returned if no tool call was applicable.
        """
        if self._cached_tool_call_response is not None:
            log.debug("Returning cached tool call response.")
            return self._cached_tool_call_response

        response = await self._generate_tool_call_response()
        self._cached_tool_call_response = response
        return response

    async def _get_last_message(self) -> ParsedBetaMessage[ResponseFormatT] | None:
        if callable(self._last_message):
            return await self._last_message()
        return self._last_message

    async def _get_last_assistant_message(self) -> ParsedBetaMessage[ResponseFormatT] | None:
        last_message = await self._get_last_message()
        if last_message is None or last_message.role != "assistant" or not last_message.content:
            return None

        return last_message

    async def _get_last_assistant_message_content(self) -> list[ParsedBetaContentBlock[ResponseFormatT]] | None:
        last_assistant_message = await self._get_last_assistant_message()
        if last_assistant_message is None:
            return None

        return last_assistant_message.content

    async def _generate_tool_call_response(self) -> BetaMessageParam | None:
        content = await self._get_last_assistant_message_content()
        if not content:
            return None

        tool_use_blocks = [block for block in content if block.type == "tool_use"]
        if not tool_use_blocks:
            return None

        results: list[BetaToolResultBlockParam] = []

        for tool_use in tool_use_blocks:
            tool = self._tools_by_name.get(tool_use.name)
            if tool is None:
                warnings.warn(
                    f"Tool '{tool_use.name}' not found in tool runner. "
                    f"Available tools: {list(self._tools_by_name.keys())}. "
                    f"If using a raw tool definition, handle the tool call manually and use `append_messages()` to add the result. "
                    f"Otherwise, pass the tool using `beta_async_tool(func)` or a `@beta_async_tool` decorated function.",
                    UserWarning,
                    stacklevel=3,
                )
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": f"Error: Tool '{tool_use.name}' not found",
                        "is_error": True,
                    }
                )
                continue

            try:
                result = await tool.call(tool_use.input)
                results.append({"type": "tool_result", "tool_use_id": tool_use.id, "content": result})
            except ToolError as exc:
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": exc.content,
                        "is_error": True,
                    }
                )
            except Exception as exc:
                log.exception(f"Error occurred while calling tool: {tool.name}", exc_info=exc)
                results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": tool_use.id,
                        "content": repr(exc),
                        "is_error": True,
                    }
                )

        return {"role": "user", "content": results}


class BetaAsyncToolRunner(BaseAsyncToolRunner[ParsedBetaMessage[ResponseFormatT], ResponseFormatT]):
    @override
    @asynccontextmanager
    async def _handle_request(self) -> AsyncIterator[ParsedBetaMessage[ResponseFormatT]]:
        message = await self._client.beta.messages.parse(**self._params, **self._options)
        self._last_message = message
        yield message


class BetaAsyncStreamingToolRunner(BaseAsyncToolRunner[BetaAsyncMessageStream[ResponseFormatT], ResponseFormatT]):
    @override
    @asynccontextmanager
    async def _handle_request(self) -> AsyncIterator[BetaAsyncMessageStream[ResponseFormatT]]:
        async with self._client.beta.messages.stream(**self._params, **self._options) as stream:
            self._last_message = stream.get_final_message
            yield stream
