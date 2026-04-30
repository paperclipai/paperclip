from __future__ import annotations

import asyncio
import logging
import random
import struct
from asyncio import TimerHandle
from io import BytesIO, StringIO
from typing import Any, Literal, cast
from urllib.parse import unquote

import wsproto
from wsproto import ConnectionType, events
from wsproto.connection import ConnectionState
from wsproto.extensions import Extension, PerMessageDeflate
from wsproto.utilities import LocalProtocolError, RemoteProtocolError

from uvicorn._types import ASGI3Application, ASGISendEvent, WebSocketEvent, WebSocketReceiveEvent, WebSocketScope
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


class FrameTooLargeError(Exception):
    """Raised when accumulated websocket message bytes exceed `ws_max_size`."""


class WebsocketBuffer:
    def __init__(self, max_length: int) -> None:
        self.value: BytesIO | StringIO | None = None
        self.length = 0
        self.max_length = max_length

    def extend(self, event: events.TextMessage | events.BytesMessage) -> None:
        if self.value is None:
            self.value = StringIO() if isinstance(event, events.TextMessage) else BytesIO()
        self.value.write(event.data)  # type: ignore[arg-type]
        # `ws_max_size` is a byte budget, so count UTF-8 bytes for text.
        self.length += len(event.data.encode()) if isinstance(event, events.TextMessage) else len(event.data)
        if self.length > self.max_length:
            raise FrameTooLargeError

    def clear(self) -> None:
        self.value = None
        self.length = 0

    def to_message(self) -> WebSocketReceiveEvent:
        if isinstance(self.value, StringIO):
            return {"type": "websocket.receive", "text": self.value.getvalue()}
        assert isinstance(self.value, BytesIO)
        return {"type": "websocket.receive", "bytes": self.value.getvalue()}


class WSProtocol(asyncio.Protocol):
    def __init__(
        self,
        config: Config,
        server_state: ServerState,
        app_state: dict[str, Any],
        _loop: asyncio.AbstractEventLoop | None = None,
    ) -> None:
        if not config.loaded:
            config.load()  # pragma: full coverage

        self.config = config
        self.app = cast(ASGI3Application, config.loaded_app)
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
        self.queue: asyncio.Queue[WebSocketEvent] = asyncio.Queue()
        self.handshake_complete = False
        self.close_sent = False

        # Rejection state
        self.response_started = False

        self.conn = wsproto.WSConnection(connection_type=ConnectionType.SERVER)

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

        # Buffer
        self.buffer = WebsocketBuffer(self.config.ws_max_size)

    # Protocol interface

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
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

    def data_received(self, data: bytes) -> None:
        try:
            self.conn.receive_data(data)
        except RemoteProtocolError as err:
            # TODO: Remove `type: ignore` when wsproto fixes the type annotation.
            self.transport.write(self.conn.send(err.event_hint))  # type: ignore[arg-type]  # noqa: E501
            self.transport.close()
        else:
            self.handle_events()

    def handle_events(self) -> None:
        for event in self.conn.events():
            if self.close_sent:
                return
            if isinstance(event, events.Request):
                self.handle_connect(event)
            elif isinstance(event, (events.TextMessage, events.BytesMessage)):
                self.handle_message(event)
            elif isinstance(event, events.CloseConnection):
                self.handle_close(event)
            elif isinstance(event, events.Ping):
                self.handle_ping(event)
            elif isinstance(event, events.Pong):
                self.handle_pong(event)

    def pause_writing(self) -> None:
        """
        Called by the transport when the write buffer exceeds the high water mark.
        """
        self.writable.clear()  # pragma: full coverage

    def resume_writing(self) -> None:
        """
        Called by the transport when the write buffer drops below the low water mark.
        """
        self.writable.set()  # pragma: full coverage

    def shutdown(self) -> None:
        self.stop_keepalive()
        if self.handshake_complete:
            self.queue.put_nowait({"type": "websocket.disconnect", "code": 1012})
            output = self.conn.send(wsproto.events.CloseConnection(code=1012))
            self.transport.write(output)
        else:
            self.send_500_response()
        self.transport.close()

    def on_task_complete(self, task: asyncio.Task[None]) -> None:
        self.tasks.discard(task)

    # Event handlers

    def handle_connect(self, event: events.Request) -> None:
        headers = [(b"host", event.host.encode())]
        headers += [(key.lower(), value) for key, value in event.extra_headers]
        raw_path, _, query_string = event.target.partition("?")
        path = unquote(raw_path)
        full_path = self.root_path + path
        full_raw_path = self.root_path.encode("ascii") + raw_path.encode("ascii")
        self.scope: WebSocketScope = {
            "type": "websocket",
            "asgi": {"version": self.config.asgi_version, "spec_version": "2.4"},
            "http_version": "1.1",
            "scheme": self.scheme,
            "server": self.server,
            "client": self.client,
            "root_path": self.root_path,
            "path": full_path,
            "raw_path": full_raw_path,
            "query_string": query_string.encode("ascii"),
            "headers": headers,
            "subprotocols": event.subprotocols,
            "state": self.app_state.copy(),
            "extensions": {"websocket.http.response": {}},
        }
        self.queue.put_nowait({"type": "websocket.connect"})
        task = self.loop.create_task(self.run_asgi())
        task.add_done_callback(self.on_task_complete)
        self.tasks.add(task)

    def handle_message(self, event: events.TextMessage | events.BytesMessage) -> None:
        try:
            self.buffer.extend(event)
        except FrameTooLargeError:
            self.close_sent = True
            reason = f"Message exceeds the maximum size ({self.config.ws_max_size} bytes)"
            self.queue.put_nowait({"type": "websocket.disconnect", "code": 1009, "reason": reason})
            if not self.transport.is_closing():
                self.transport.write(self.conn.send(wsproto.events.CloseConnection(code=1009, reason=reason)))
                self.transport.close()
            return
        if event.message_finished:
            self.queue.put_nowait(self.buffer.to_message())
            self.buffer.clear()
            if not self.read_paused:
                self.read_paused = True
                self.transport.pause_reading()

    def handle_close(self, event: events.CloseConnection) -> None:
        if self.conn.state == ConnectionState.REMOTE_CLOSING:
            self.transport.write(self.conn.send(event.response()))
        self.queue.put_nowait({"type": "websocket.disconnect", "code": event.code, "reason": event.reason})
        self.transport.close()

    def handle_ping(self, event: events.Ping) -> None:
        self.transport.write(self.conn.send(event.response()))

    def handle_pong(self, event: events.Pong) -> None:
        # Ignore unsolicited pongs and stale pongs whose payload doesn't match the ping currently in flight.
        if self.pending_ping_payload is None or bytes(event.payload) != self.pending_ping_payload:
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
        self.pending_ping_payload = struct.pack("!I", random.getrandbits(32))
        self.ping_sent_at = self.loop.time()
        self.transport.write(self.conn.send(wsproto.events.Ping(payload=self.pending_ping_payload)))
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
        reason = "keepalive ping timeout"
        self.transport.write(self.conn.send(wsproto.events.CloseConnection(code=1011, reason=reason)))
        self.close_sent = True
        self.transport.close()

    def send_500_response(self) -> None:
        if self.response_started or self.handshake_complete:
            return  # we cannot send responses anymore
        headers: list[tuple[bytes, bytes]] = [
            (b"content-type", b"text/plain; charset=utf-8"),
            (b"connection", b"close"),
            (b"content-length", b"21"),
        ]
        output = self.conn.send(wsproto.events.RejectConnection(status_code=500, headers=headers, has_body=True))
        output += self.conn.send(wsproto.events.RejectData(data=b"Internal Server Error"))
        self.transport.write(output)

    async def run_asgi(self) -> None:
        try:
            result = await self.app(self.scope, self.receive, self.send)  # type: ignore[func-returns-value]
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

    async def send(self, message: ASGISendEvent) -> None:
        await self.writable.wait()

        if not self.handshake_complete:
            if message["type"] == "websocket.accept":
                self.logger.info(
                    '%s - "WebSocket %s" [accepted]',
                    get_client_addr(self.scope),
                    get_path_with_query_string(self.scope),
                )
                subprotocol = message.get("subprotocol")
                extra_headers = self.default_headers + list(message.get("headers", []))
                extensions: list[Extension] = []
                if self.config.ws_per_message_deflate:
                    extensions.append(PerMessageDeflate())
                if not self.transport.is_closing():
                    self.handshake_complete = True
                    output = self.conn.send(
                        wsproto.events.AcceptConnection(
                            subprotocol=subprotocol,
                            extensions=extensions,
                            extra_headers=extra_headers,
                        )
                    )
                    self.transport.write(output)
                    self.start_keepalive()

            elif message["type"] == "websocket.close":
                self.queue.put_nowait({"type": "websocket.disconnect", "code": 1006})
                self.logger.info(
                    '%s - "WebSocket %s" 403',
                    get_client_addr(self.scope),
                    get_path_with_query_string(self.scope),
                )
                self.handshake_complete = True
                self.close_sent = True
                event = events.RejectConnection(status_code=403, headers=[])
                output = self.conn.send(event)
                self.transport.write(output)
                self.transport.close()

            elif message["type"] == "websocket.http.response.start":
                # ensure status code is in the valid range
                if not (100 <= message["status"] < 600):
                    msg = "Invalid HTTP status code '%d' in response."
                    raise RuntimeError(msg % message["status"])
                self.logger.info(
                    '%s - "WebSocket %s" %d',
                    get_client_addr(self.scope),
                    get_path_with_query_string(self.scope),
                    message["status"],
                )
                self.handshake_complete = True
                event = events.RejectConnection(
                    status_code=message["status"],
                    headers=list(message["headers"]),
                    has_body=True,
                )
                output = self.conn.send(event)
                self.transport.write(output)
                self.response_started = True

            else:
                raise RuntimeError(
                    "Expected ASGI message 'websocket.accept', 'websocket.close' "
                    f"or 'websocket.http.response.start' but got '{message['type']}'."
                )

        elif not self.close_sent and not self.response_started:
            try:
                if message["type"] == "websocket.send":
                    bytes_data = message.get("bytes")
                    text_data = message.get("text")
                    data = text_data if bytes_data is None else bytes_data
                    output = self.conn.send(wsproto.events.Message(data=data))  # type: ignore
                    if not self.transport.is_closing():
                        self.transport.write(output)

                elif message["type"] == "websocket.close":
                    self.close_sent = True
                    code = message.get("code", 1000)
                    reason = message.get("reason", "") or ""
                    self.queue.put_nowait({"type": "websocket.disconnect", "code": code, "reason": reason})
                    output = self.conn.send(wsproto.events.CloseConnection(code=code, reason=reason))
                    if not self.transport.is_closing():
                        self.transport.write(output)
                        self.transport.close()

                else:
                    raise RuntimeError(
                        f"Expected ASGI message 'websocket.send' or 'websocket.close', but got '{message['type']}'."
                    )
            except LocalProtocolError as exc:
                raise ClientDisconnected from exc
        elif self.response_started:
            if message["type"] == "websocket.http.response.body":
                body_finished = not message.get("more_body", False)
                reject_data = events.RejectData(data=message["body"], body_finished=body_finished)
                output = self.conn.send(reject_data)
                self.transport.write(output)

                if body_finished:
                    self.queue.put_nowait({"type": "websocket.disconnect", "code": 1006})
                    self.close_sent = True
                    self.transport.close()

            else:
                raise RuntimeError(f"Expected ASGI message 'websocket.http.response.body' but got '{message['type']}'.")

        else:
            raise RuntimeError(f"Unexpected ASGI message '{message['type']}', after sending 'websocket.close'.")

    async def receive(self) -> WebSocketEvent:
        message = await self.queue.get()
        if self.read_paused and self.queue.empty():
            self.read_paused = False
            self.transport.resume_reading()
        return message
