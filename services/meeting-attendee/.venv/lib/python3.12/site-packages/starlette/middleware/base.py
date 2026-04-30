from __future__ import annotations

from collections.abc import AsyncGenerator, AsyncIterable, Awaitable, Callable, Mapping, MutableMapping
from typing import Any, TypeVar

import anyio

from starlette._utils import collapse_excgroups
from starlette.requests import ClientDisconnect, Request
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

RequestResponseEndpoint = Callable[[Request], Awaitable[Response]]
DispatchFunction = Callable[[Request, RequestResponseEndpoint], Awaitable[Response]]
BodyStreamGenerator = AsyncGenerator[bytes | MutableMapping[str, Any], None]
AsyncContentStream = AsyncIterable[str | bytes | memoryview | MutableMapping[str, Any]]
T = TypeVar("T")


class _CachedRequest(Request):
    """
    If the user calls Request.body() from their dispatch function
    we cache the entire request body in memory and pass that to downstream middlewares,
    but if they call Request.stream() then all we do is send an
    empty body so that downstream things don't hang forever.
    """

    def __init__(self, scope: Scope, receive: Receive):
        super().__init__(scope, receive)
        self._wrapped_rcv_disconnected = False
        self._wrapped_rcv_consumed = False
        self._wrapped_rc_stream = self.stream()

    async def wrapped_receive(self) -> Message:
        # wrapped_rcv state 1: disconnected
        if self._wrapped_rcv_disconnected:
            # we've already sent a disconnect to the downstream app
            # we don't need to wait to get another one
            # (although most ASGI servers will just keep sending it)
            return {"type": "http.disconnect"}
        # wrapped_rcv state 1: consumed but not yet disconnected
        if self._wrapped_rcv_consumed:
            # since the downstream app has consumed us all that is left
            # is to send it a disconnect
            if self._is_disconnected:
                # the middleware has already seen the disconnect
                # since we know the client is disconnected no need to wait
                # for the message
                self._wrapped_rcv_disconnected = True
                return {"type": "http.disconnect"}
            # we don't know yet if the client is disconnected or not
            # so we'll wait until we get that message
            msg = await self.receive()
            if msg["type"] != "http.disconnect":  # pragma: no cover
                # at this point a disconnect is all that we should be receiving
                # if we get something else, things went wrong somewhere
                raise RuntimeError(f"Unexpected message received: {msg['type']}")
            self._wrapped_rcv_disconnected = True
            return msg

        # wrapped_rcv state 3: not yet consumed
        if getattr(self, "_body", None) is not None:
            # body() was called, we return it even if the client disconnected
            self._wrapped_rcv_consumed = True
            return {
                "type": "http.request",
                "body": self._body,
                "more_body": False,
            }
        elif self._stream_consumed:
            # stream() was called to completion
            # return an empty body so that downstream apps don't hang
            # waiting for a disconnect
            self._wrapped_rcv_consumed = True
            return {
                "type": "http.request",
                "body": b"",
                "more_body": False,
            }
        else:
            # body() was never called and stream() wasn't consumed
            try:
                stream = self.stream()
                chunk = await stream.__anext__()
                self._wrapped_rcv_consumed = self._stream_consumed
                return {
                    "type": "http.request",
                    "body": chunk,
                    "more_body": not self._stream_consumed,
                }
            except ClientDisconnect:
                self._wrapped_rcv_disconnected = True
                return {"type": "http.disconnect"}


class BaseHTTPMiddleware:
    def __init__(self, app: ASGIApp, dispatch: DispatchFunction | None = None) -> None:
        self.app = app
        self.dispatch_func = self.dispatch if dispatch is None else dispatch

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = _CachedRequest(scope, receive)
        wrapped_receive = request.wrapped_receive
        response_sent = anyio.Event()
        app_exc: Exception | None = None
        exception_already_raised = False

        async def call_next(request: Request) -> Response:
            async def receive_or_disconnect() -> Message:
                if response_sent.is_set():
                    return {"type": "http.disconnect"}

                async with anyio.create_task_group() as task_group:

                    async def wrap(func: Callable[[], Awaitable[T]]) -> T:
                        result = await func()
                        task_group.cancel_scope.cancel()
                        return result

                    task_group.start_soon(wrap, response_sent.wait)
                    message = await wrap(wrapped_receive)

                if response_sent.is_set():
                    return {"type": "http.disconnect"}

                return message

            async def send_no_error(message: Message) -> None:
                try:
                    await send_stream.send(message)
                except anyio.BrokenResourceError:
                    # recv_stream has been closed, i.e. response_sent has been set.
                    return

            async def coro() -> None:
                nonlocal app_exc

                with send_stream:
                    try:
                        await self.app(scope, receive_or_disconnect, send_no_error)
                    except Exception as exc:
                        app_exc = exc

            task_group.start_soon(coro)

            try:
                message = await recv_stream.receive()
                info = message.get("info", None)
                if message["type"] == "http.response.debug" and info is not None:
                    message = await recv_stream.receive()
            except anyio.EndOfStream:
                if app_exc is not None:
                    nonlocal exception_already_raised
                    exception_already_raised = True
                    # Prevent `anyio.EndOfStream` from polluting app exception context.
                    # If both cause and context are None then the context is suppressed
                    # and `anyio.EndOfStream` is not present in the exception traceback.
                    # If exception cause is not None then it is propagated with
                    # reraising here.
                    # If exception has no cause but has context set then the context is
                    # propagated as a cause with the reraise. This is necessary in order
                    # to prevent `anyio.EndOfStream` from polluting the exception
                    # context.
                    raise app_exc from app_exc.__cause__ or app_exc.__context__
                raise RuntimeError("No response returned.")

            assert message["type"] == "http.response.start"

            async def body_stream() -> BodyStreamGenerator:
                async for message in recv_stream:
                    if message["type"] == "http.response.pathsend":
                        yield message
                        break
                    assert message["type"] == "http.response.body", f"Unexpected message: {message}"
                    body = message.get("body", b"")
                    if body:
                        yield body
                    if not message.get("more_body", False):
                        break

            response = _StreamingResponse(status_code=message["status"], content=body_stream(), info=info)
            response.raw_headers = message["headers"]
            return response

        streams: anyio.create_memory_object_stream[Message] = anyio.create_memory_object_stream()
        send_stream, recv_stream = streams
        with recv_stream, send_stream, collapse_excgroups():
            async with anyio.create_task_group() as task_group:
                response = await self.dispatch_func(request, call_next)
                await response(scope, wrapped_receive, send)
                response_sent.set()
                recv_stream.close()
        if app_exc is not None and not exception_already_raised:
            raise app_exc

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        raise NotImplementedError()  # pragma: no cover


class _StreamingResponse(Response):
    def __init__(
        self,
        content: AsyncContentStream,
        status_code: int = 200,
        headers: Mapping[str, str] | None = None,
        media_type: str | None = None,
        info: Mapping[str, Any] | None = None,
    ) -> None:
        self.info = info
        self.body_iterator = content
        self.status_code = status_code
        self.media_type = media_type
        self.init_headers(headers)
        self.background = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.info is not None:
            await send({"type": "http.response.debug", "info": self.info})
        await send(
            {
                "type": "http.response.start",
                "status": self.status_code,
                "headers": self.raw_headers,
            }
        )

        should_close_body = True
        async for chunk in self.body_iterator:
            if isinstance(chunk, dict):
                # We got an ASGI message which is not response body (eg: pathsend)
                should_close_body = False
                await send(chunk)
                continue
            await send({"type": "http.response.body", "body": chunk, "more_body": True})

        if should_close_body:
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        if self.background:
            await self.background()
