import gzip
import io
from typing import NoReturn

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

DEFAULT_EXCLUDED_CONTENT_TYPES = ("text/event-stream",)


class GZipMiddleware:
    def __init__(self, app: ASGIApp, minimum_size: int = 500, compresslevel: int = 9) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":  # pragma: no cover
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        responder: ASGIApp
        if "gzip" in headers.get("Accept-Encoding", ""):
            responder = GZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)
        else:
            responder = IdentityResponder(self.app, self.minimum_size)

        await responder(scope, receive, send)


class IdentityResponder:
    content_encoding: str

    def __init__(self, app: ASGIApp, minimum_size: int) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.send: Send = unattached_send
        self.initial_message: Message = {}
        self.started = False
        self.content_encoding_set = False
        self.content_type_is_excluded = False

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        self.send = send
        await self.app(scope, receive, self.send_with_compression)

    async def send_with_compression(self, message: Message) -> None:
        message_type = message["type"]
        if message_type == "http.response.start":
            # Don't send the initial message until we've determined how to
            # modify the outgoing headers correctly.
            self.initial_message = message
            headers = Headers(raw=self.initial_message["headers"])
            self.content_encoding_set = "content-encoding" in headers
            self.content_type_is_excluded = headers.get("content-type", "").startswith(DEFAULT_EXCLUDED_CONTENT_TYPES)
        elif message_type == "http.response.body" and (self.content_encoding_set or self.content_type_is_excluded):
            if not self.started:
                self.started = True
                await self.send(self.initial_message)
            await self.send(message)
        elif message_type == "http.response.body" and not self.started:
            self.started = True
            body = message.get("body", b"")
            more_body = message.get("more_body", False)
            if len(body) < self.minimum_size and not more_body:
                # Don't apply compression to small outgoing responses.
                await self.send(self.initial_message)
                await self.send(message)
            elif not more_body:
                # Standard response.
                body = self.apply_compression(body, more_body=False)

                headers = MutableHeaders(raw=self.initial_message["headers"])
                headers.add_vary_header("Accept-Encoding")
                if body != message["body"]:
                    headers["Content-Encoding"] = self.content_encoding
                    headers["Content-Length"] = str(len(body))
                    message["body"] = body

                await self.send(self.initial_message)
                await self.send(message)
            else:
                # Initial body in streaming response.
                body = self.apply_compression(body, more_body=True)

                headers = MutableHeaders(raw=self.initial_message["headers"])
                headers.add_vary_header("Accept-Encoding")
                if body != message["body"]:
                    headers["Content-Encoding"] = self.content_encoding
                    del headers["Content-Length"]
                    message["body"] = body

                await self.send(self.initial_message)
                await self.send(message)
        elif message_type == "http.response.body":
            # Remaining body in streaming response.
            body = message.get("body", b"")
            more_body = message.get("more_body", False)

            message["body"] = self.apply_compression(body, more_body=more_body)

            await self.send(message)
        elif message_type == "http.response.pathsend":  # pragma: no branch
            # Don't apply GZip to pathsend responses
            await self.send(self.initial_message)
            await self.send(message)

    def apply_compression(self, body: bytes, *, more_body: bool) -> bytes:
        """Apply compression on the response body.

        If more_body is False, any compression file should be closed. If it
        isn't, it won't be closed automatically until all background tasks
        complete.
        """
        return body


class GZipResponder(IdentityResponder):
    content_encoding = "gzip"

    def __init__(self, app: ASGIApp, minimum_size: int, compresslevel: int = 9) -> None:
        super().__init__(app, minimum_size)

        self.gzip_buffer = io.BytesIO()
        self.gzip_file = gzip.GzipFile(mode="wb", fileobj=self.gzip_buffer, compresslevel=compresslevel)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        with self.gzip_buffer, self.gzip_file:
            await super().__call__(scope, receive, send)

    def apply_compression(self, body: bytes, *, more_body: bool) -> bytes:
        self.gzip_file.write(body)
        if not more_body:
            self.gzip_file.close()

        body = self.gzip_buffer.getvalue()
        self.gzip_buffer.seek(0)
        self.gzip_buffer.truncate()

        return body


async def unattached_send(message: Message) -> NoReturn:
    raise RuntimeError("send awaitable not set")  # pragma: no cover
