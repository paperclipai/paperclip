from __future__ import annotations

import asyncio
import logging
import random
import struct
import sys
from asyncio import TimerHandle
from asyncio.transports import BaseTransport, Transport
from http import HTTPStatus
from typing import Any, Literal, cast
from urllib.parse import unquote

from websockets.exceptions import InvalidState
from websockets.extensions.permessage_deflate import ServerPerMessageDeflateFactory
from websockets.frames import Frame, Opcode
from websockets.http11 import Request
from websockets.server import ServerProtocol

from uvicorn._types import (
    ASGIReceiveEvent,
    ASGISendEvent,
    WebSocketScope,
)
from uvicorn.config import Config
from uvicorn.logging import TRACE_LOG_LEVEL
from uvicorn.protocols.utils import (
    ClientDisconnected,
    get_client_addr,
    get_local_addr,
    get_path_with_query_string,
    get_remote_addr,
    is_ssl,
)
from uvicorn.server import ServerState

if sys.version_info >= (3, 11):  # pragma: no cover
    from typing import assert_never
else:  # pragma: no cover
    from typing_extensions import assert_never


class WebSocketsSansIOProtocol(asyncio.Protocol):
    def __init__(
        self,
        config: Config,
        server_state: ServerState,
        app_state: dict[str, Any],
        _loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        if not config.loaded:
            config.load()  # pragma: no cover

        self.config = config
        self.app = config.loaded_app
        self.loop = _loop or asyncio.get_event_loop()
        self.logger = logging.getLogger("uvicorn.error")
        self.root_path = config.root_path
        self.app_state = app_state

        # Shared server state
        self.connections = server_state.connections
        self.tasks = server_state.tasks
        self.default_headers = server_state.default_headers

        # Connection state
        self.transport: asyncio.Transport = None  # type: ignore[assignment]
        self.server: tuple[str, int | None] | None = None
        self.client: tuple[str, int] | None = None
        self.scheme: Literal["wss", "ws"] = None  # type: ignore[assignment]

        # WebSocket state
        self.queue: asyncio.Queue[ASGIReceiveEvent] = asyncio.Queue()
        self.handshake_initiated = False
        self.handshake_complete = False
        self.close_sent = False
        self.initial_response: tuple[int, list[tuple[str, str]], bytes] | None = None

        extensions = []
        if self.config.ws_per_message_deflate:
            extensions = [
                ServerPerMessageDeflateFactory(
                    server_max_window_bits=12,
                    client_max_window_bits=12,
                    compress_settings={"memLevel": 5},
                )
            ]
        self.conn = ServerProtocol(
            extensions=extensions,
            max_size=self.config.ws_max_size,
            logger=logging.getLogger("uvicorn.error"),
        )

        self.read_paused = False
        self.writable = asyncio.Event()
        self.writable.set()

        # Keepalive state
        self.ping_interval = config.ws_ping_interval
        self.ping_timeout = config.ws_ping_timeout
        self.ping_timer: TimerHandle | None = None
        self.pong_timer: TimerHandle | None = None
        self.pending_ping_payload: bytes | None = None
        self.ping_sent_at: float = 0.0
        self.last_ping_rtt: float = 0.0

        # Buffers
        self.bytes = bytearray()

    def connection_made(self, transport: BaseTransport) -> None:
        """Called when a connection is made."""
        transport = cast(Transport, transport)
        self.connections.add(self)
        self.transport = transport
        self.server = get_local_addr(transport)
        self.client = get_remote_addr(transport)
        self.scheme = "wss" if is_ssl(transport) else "ws"

        if self.logger.level <= TRACE_LOG_LEVEL:
            prefix = "%s:%d - " % self.client if self.client else ""
            self.logger.log(TRACE_LOG_LEVEL, "%sWebSocket connection made", prefix)

    def connection_lost(self, exc: Exception | None) -> None:
        self.stop_keepalive()
        code = 1005 if self.handshake_complete else 1006
        self.queue.put_nowait({"type": "websocket.disconnect", "code": code})
        self.connections.remove(self)

        if self.logger.level <= TRACE_LOG_LEVEL:
            prefix = "%s:%d - " % self.client if self.client else ""
            self.logger.log(TRACE_LOG_LEVEL, "%sWebSocket connection lost", prefix)

        self.handshake_complete = True
        if exc is None:
            self.transport.close()

    def eof_received(self) -> None:
        pass

    def shutdown(self) -> None:
        self.stop_keepalive()
        if self.handshake_complete:
            self.queue.put_nowait({"type": "websocket.disconnect", "code": 1012})
            self.conn.send_close(1012)
            output = self.conn.data_to_send()
            self.transport.write(b"".join(output))
        else:
            self.send_500_response()
        self.transport.close()

    def data_received(self, data: bytes) -> None:
        self.conn.receive_data(data)
        if self.conn.parser_exc is not None:  # pragma: no cover
            self.handle_parser_exception()
            return
        self.handle_events()

    def handle_events(self) -> None:
        for event in self.conn.events_received():
            if isinstance(event, Request):
                self.handle_connect(event)
            if isinstance(event, Frame):
                if event.opcode == Opcode.CONT:
                    self.handle_cont(event)  # pragma: no cover
                elif event.opcode == Opcode.TEXT:
                    self.handle_text(event)
                elif event.opcode == Opcode.BINARY:
                    self.handle_bytes(event)
                elif event.opcode == Opcode.PING:
                    self.handle_ping()
                elif event.opcode == Opcode.PONG:
                    self.handle_pong(event)
                elif event.opcode == Opcode.CLOSE:
                    self.handle_close(event)
                else:
                    assert_never(event.opcode)  # pragma: no cover

    # Event handlers

    def handle_connect(self, event: Request) -> None:
        self.request = event
        self.response = self.conn.accept(event)
        self.handshake_initiated = True
        if self.response.status_code != 101:
            self.handshake_complete = True
            self.close_sent = True
            self.conn.send_response(self.response)
            output = self.conn.data_to_send()
            self.transport.write(b"".join(output))
            self.transport.close()
            return

        headers = [
            (key.encode("ascii"), value.encode("ascii", errors="surrogateescape"))
            for key, value in event.headers.raw_items()
        ]
        raw_path, _, query_string = event.path.partition("?")
        self.scope: WebSocketScope = {
            "type": "websocket",
            "asgi": {"version": self.config.asgi_version, "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": self.scheme,
            "server": self.server,
            "client": self.client,
            "root_path": self.root_path,
            "path": self.root_path + unquote(raw_path),
            "raw_path": self.root_path.encode("ascii") + raw_path.encode("ascii"),
            "query_string": query_string.encode("ascii"),
            "headers": headers,
            "subprotocols": event.headers.get_all("Sec-WebSocket-Protocol"),
            "state": self.app_state.copy(),
            "extensions": {"websocket.http.response": {}},
        }
        self.queue.put_nowait({"type": "websocket.connect"})
        task = self.loop.create_task(self.run_asgi())
        task.add_done_callback(self.on_task_complete)
        self.tasks.add(task)

    def handle_cont(self, event: Frame) -> None:
        self.bytes.extend(event.data)
        if event.fin:
            self.send_receive_event_to_app()

    def handle_text(self, event: Frame) -> None:
        self.bytes = bytearray(event.data)
        self.curr_msg_data_type: Literal["text", "bytes"] = "text"
        if event.fin:
            self.send_receive_event_to_app()

    def handle_bytes(self, event: Frame) -> None:
        self.bytes = bytearray(event.data)
        self.curr_msg_data_type = "bytes"
        if event.fin:
            self.send_receive_event_to_app()

    def send_receive_event_to_app(self) -> None:
        if self.curr_msg_data_type == "text":
            try:
                self.queue.put_nowait({"type": "websocket.receive", "text": self.bytes.decode()})
            except UnicodeDecodeError:  # pragma: no cover
                self.logger.exception("Invalid UTF-8 sequence received from client.")
                self.conn.send_close(1007)
                self.handle_parser_exception()
                return
        else:
            self.queue.put_nowait({"type": "websocket.receive", "bytes": bytes(self.bytes)})
        if not self.read_paused:
            self.read_paused = True
            self.transport.pause_reading()

    def handle_ping(self) -> None:
        output = self.conn.data_to_send()
        self.transport.write(b"".join(output))

    def handle_pong(self, event: Frame) -> None:
        # Ignore unsolicited pongs and stale pongs whose payload doesn't match the ping currently in flight
        if self.pending_ping_payload is None or bytes(event.data) != self.pending_ping_payload:
            return  # pragma: no cover

        self.last_ping_rtt = self.loop.time() - self.ping_sent_at
        self.pending_ping_payload = None
        # The peer answered in time; cancel the pong deadline and chain the next ping. This `schedule_ping()` call is
        # what keeps the keepalive loop running when ping_timeout is set. When ping_timeout is None the next ping is
        # already scheduled by `send_keepalive_ping`, so we must not schedule a duplicate here.
        if self.pong_timer is not None:
            self.pong_timer.cancel()
            self.pong_timer = None
            self.schedule_ping()

    def start_keepalive(self) -> None:
        if self.ping_interval is not None and self.ping_interval > 0:
            self.schedule_ping()

    def stop_keepalive(self) -> None:
        if self.ping_timer is not None:
            self.ping_timer.cancel()
            self.ping_timer = None
        if self.pong_timer is not None:  # pragma: no cover
            self.pong_timer.cancel()
            self.pong_timer = None
        self.pending_ping_payload = None

    def schedule_ping(self) -> None:
        assert self.ping_interval is not None
        delay = max(0.0, self.ping_interval - self.last_ping_rtt)
        self.ping_timer = self.loop.call_later(delay, self.send_keepalive_ping)

    def send_keepalive_ping(self) -> None:
        self.ping_timer = None
        if self.close_sent or self.transport.is_closing():  # pragma: no cover
            return
        # Random 4-byte payload identifies this ping; `handle_pong` uses it to ignore stale or unsolicited pongs.
        # See https://github.com/python-websockets/websockets/blob/4d229bf9f583d593aa103287aee0a77c9fbc3a79/src/websockets/asyncio/connection.py#L624
        self.pending_ping_payload = struct.pack("!I", random.getrandbits(32))
        self.ping_sent_at = self.loop.time()
        self.conn.send_ping(self.pending_ping_payload)
        self.transport.write(b"".join(self.conn.data_to_send()))
        if self.ping_timeout is not None:
            self.pong_timer = self.loop.call_later(self.ping_timeout, self.keepalive_timeout)
        else:  # pragma: no cover
            self.schedule_ping()

    def keepalive_timeout(self) -> None:
        self.pong_timer = None
        self.pending_ping_payload = None
        if self.close_sent or self.transport.is_closing():  # pragma: no cover
            return
        if self.logger.level <= TRACE_LOG_LEVEL:
            prefix = "%s:%d - " % self.client if self.client else ""
            self.logger.log(TRACE_LOG_LEVEL, "%sWebSocket keepalive ping timeout", prefix)
        self.conn.fail(1011, "keepalive ping timeout")
        self.transport.write(b"".join(self.conn.data_to_send()))
        self.close_sent = True
        self.transport.close()

    def handle_close(self, event: Frame) -> None:
        if not self.close_sent and not self.transport.is_closing():
            assert self.conn.close_rcvd is not None
            code = self.conn.close_rcvd.code
            reason = self.conn.close_rcvd.reason
            self.queue.put_nowait({"type": "websocket.disconnect", "code": code, "reason": reason})

            output = self.conn.data_to_send()
            self.transport.write(b"".join(output))
            self.transport.close()

    def handle_parser_exception(self) -> None:  # pragma: no cover
        assert self.conn.close_sent is not None
        code = self.conn.close_sent.code
        reason = self.conn.close_sent.reason
        self.queue.put_nowait({"type": "websocket.disconnect", "code": code, "reason": reason})

        output = self.conn.data_to_send()
        self.transport.write(b"".join(output))
        self.close_sent = True
        self.transport.close()

    def on_task_complete(self, task: asyncio.Task[None]) -> None:
        self.tasks.discard(task)

    async def run_asgi(self) -> None:
        try:
            result = await self.app(self.scope, self.receive, self.send)
        except ClientDisconnected:
            pass  # pragma: full coverage
        except BaseException:
            self.logger.exception("Exception in ASGI application\n")
            self.send_500_response()
        else:
            if not self.handshake_complete:
                self.logger.error("ASGI callable returned without completing handshake.")
                self.send_500_response()
            elif result is not None:
                self.logger.error("ASGI callable should return None, but returned '%s'.", result)
        self.transport.close()

    def send_500_response(self) -> None:
        if self.initial_response or self.handshake_complete:
            return
        response = self.conn.reject(500, "Internal Server Error")
        self.conn.send_response(response)
        output = self.conn.data_to_send()
        self.transport.write(b"".join(output))

    async def send(self, message: ASGISendEvent) -> None:
        await self.writable.wait()

        if not self.handshake_complete and self.initial_response is None:
            if message["type"] == "websocket.accept":
                self.logger.info(
                    '%s - "WebSocket %s" [accepted]',
                    get_client_addr(self.scope),
                    get_path_with_query_string(self.scope),
                )
                headers = [
                    (name.decode("latin-1").lower(), value.decode("latin-1"))
                    for name, value in (self.default_headers + list(message.get("headers", [])))
                ]
                accepted_subprotocol = message.get("subprotocol")
                if accepted_subprotocol:
                    headers.append(("Sec-WebSocket-Protocol", accepted_subprotocol))
                self.response.headers.update(headers)

                if not self.transport.is_closing():
                    self.handshake_complete = True
                    self.conn.send_response(self.response)
                    output = self.conn.data_to_send()
                    self.transport.write(b"".join(output))
                    self.start_keepalive()

            elif message["type"] == "websocket.close":
                self.queue.put_nowait({"type": "websocket.disconnect", "code": 1006})
                self.logger.info(
                    '%s - "WebSocket %s" 403',
                    get_client_addr(self.scope),
                    get_path_with_query_string(self.scope),
                )
                response = self.conn.reject(HTTPStatus.FORBIDDEN, "")
                self.conn.send_response(response)
                output = self.conn.data_to_send()
                self.close_sent = True
                self.handshake_complete = True
                self.transport.write(b"".join(output))
                self.transport.close()
            elif message["type"] == "websocket.http.response.start" and self.initial_response is None:
                if not (100 <= message["status"] < 600):
                    raise RuntimeError("Invalid HTTP status code '%d' in response." % message["status"])
                self.logger.info(
                    '%s - "WebSocket %s" %d',
                    get_client_addr(self.scope),
                    get_path_with_query_string(self.scope),
                    message["status"],
                )
                headers = [
                    (name.decode("latin-1"), value.decode("latin-1"))
                    for name, value in list(message.get("headers", []))
                ]
                self.initial_response = (message["status"], headers, b"")
            else:
                raise RuntimeError(
                    "Expected ASGI message 'websocket.accept', 'websocket.close' "
                    f"or 'websocket.http.response.start' but got '{message['type']}'."
                )

        elif not self.close_sent and self.initial_response is None:
            try:
                if message["type"] == "websocket.send":
                    bytes_data = message.get("bytes")
                    text_data = message.get("text")
                    if bytes_data is not None:
                        self.conn.send_binary(bytes_data)
                    elif text_data is not None:
                        self.conn.send_text(text_data.encode())
                    output = self.conn.data_to_send()
                    self.transport.write(b"".join(output))

                elif message["type"] == "websocket.close":
                    if not self.transport.is_closing():
                        code = message.get("code", 1000)
                        reason = message.get("reason", "") or ""
                        self.queue.put_nowait({"type": "websocket.disconnect", "code": code, "reason": reason})
                        self.conn.send_close(code, reason)
                        output = self.conn.data_to_send()
                        self.transport.write(b"".join(output))
                        self.close_sent = True
                        self.transport.close()
                else:
                    raise RuntimeError(
                        f"Expected ASGI message 'websocket.send' or 'websocket.close', but got '{message['type']}'."
                    )
            except InvalidState:
                raise ClientDisconnected()
        elif self.initial_response is not None:
            if message["type"] == "websocket.http.response.body":
                body = self.initial_response[2] + message["body"]
                self.initial_response = self.initial_response[:2] + (body,)
                if not message.get("more_body", False):
                    response = self.conn.reject(self.initial_response[0], body.decode())
                    response.headers.update(self.initial_response[1])
                    self.queue.put_nowait({"type": "websocket.disconnect", "code": 1006})
                    self.conn.send_response(response)
                    output = self.conn.data_to_send()
                    self.close_sent = True
                    self.transport.write(b"".join(output))
                    self.transport.close()
            else:  # pragma: no cover
                raise RuntimeError(f"Expected ASGI message 'websocket.http.response.body' but got '{message['type']}'.")

        else:
            raise RuntimeError(f"Unexpected ASGI message '{message['type']}', after sending 'websocket.close'.")

    async def receive(self) -> ASGIReceiveEvent:
        message = await self.queue.get()
        if self.read_paused and self.queue.empty():
            self.read_paused = False
            self.transport.resume_reading()
        return message
