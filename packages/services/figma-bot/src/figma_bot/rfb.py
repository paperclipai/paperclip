"""RFB pointer-event injection via websockify → x11vnc.

Bypasses Camoufox/Firefox's isTrusted=false trap on React-protected
buttons (e.g. Figma's "Continue with Google" button on the login page).
Coords are Xvfb-native (1920x1080). See memory entry
`camoufox_istrusted_false_rfb_workaround.md` for the durable pattern.
"""

from __future__ import annotations

import base64
import os
import socket
import struct
import time

from . import state
from .config import _RFB_BUTTON_HOLD_S


class RFBConnectFailed(Exception):
    """websockify or x11vnc unreachable / handshake failed / send timed out.
    Caller maps this to reason='rfb_unreachable' on the /lease/acquire 503."""


def rfb_click(
    x: int,
    y: int,
    *,
    host: str = "127.0.0.1",
    port: int = 6080,
    connect_timeout: float = 10.0,
    op_timeout: float = 30.0,
) -> None:
    """Inject a real X PointerEvent at (x,y) via websockify → x11vnc.

    Bypasses Camoufox/Firefox isTrusted=false on React-protected buttons.
    Coords are Xvfb-native (1920x1080). Raises RFBConnectFailed on any
    socket/handshake/timeout error.

    Timeout rationale (BLO-6870 followup, 2026-05-24): x11vnc's
    ServerInit step is serialized with Xvfb screen-capture, so when
    Camoufox is actively rendering (e.g., right after page.goto to
    Figma's login page), the handshake can stall for 10+ seconds.
    rfb_click is called IMMEDIATELY after `wait_for_load_state` /
    `wait_for_selector` in `login.do_login`, exactly when Camoufox is
    busiest. Idle-state benchmark: handshake completes in ~0.3s. The
    failure mode with op_timeout=3.0 was the bot's RFB connection
    being killed mid-handshake by its own socket timeout, surfacing
    as `rfb_unreachable` (RFBConnectFailed("socket error: timeout")).

    PR #156 bumped 3.0s → 15.0s. Live observation 2026-05-24 22:56:11
    showed the 15s budget still firing under Camoufox cold-boot +
    figma.com/login render — RFB-click 22:56:11 → ProfileManager
    closed 22:56:26 (15s later, exactly at the boundary). Bumped to
    30.0s to absorb cold-boot variance. The 30s ceiling still bounds
    the worst case so a truly hung x11vnc can't strand the lease for
    the full 30min TTL.
    """
    sock: socket.socket | None = None
    t0 = time.monotonic()

    def _dt() -> str:
        return f"{time.monotonic() - t0:.2f}s"

    state.log(f"rfb_click: begin xy=({x},{y}) op_timeout={op_timeout}s")
    try:
        nonce = base64.b64encode(os.urandom(16)).decode("ascii")
        sock = socket.create_connection((host, port), timeout=connect_timeout)
        sock.settimeout(op_timeout)
        state.log(f"rfb_click: connected to {host}:{port} (t={_dt()})")
        req = (
            f"GET / HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {nonce}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"Sec-WebSocket-Protocol: binary\r\n"
            f"Origin: http://{host}:{port}\r\n\r\n"
        )
        sock.sendall(req.encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise RFBConnectFailed(f"ws handshake: closed before headers (t={_dt()})")
            buf += chunk
            if len(buf) > 65536:
                raise RFBConnectFailed(f"ws handshake: oversized response (t={_dt()})")
        if b"101" not in buf.split(b"\r\n", 1)[0]:
            raise RFBConnectFailed(
                f"ws handshake: bad status {buf.split(b' ')[1] if b' ' in buf else b'?'} (t={_dt()})"
            )
        state.log(f"rfb_click: ws upgrade ok (t={_dt()})")

        def _sock_recv_exact(n: int) -> bytes:
            out = bytearray()
            while len(out) < n:
                chunk = sock.recv(n - len(out))
                if not chunk:
                    raise RFBConnectFailed(f"ws recv: socket closed mid-frame (t={_dt()})")
                out += chunk
            return bytes(out)

        def _ws_send(payload: bytes) -> None:
            mask = os.urandom(4)
            length = len(payload)
            header = bytearray([0x82])
            if length < 126:
                header.append(0x80 | length)
            elif length < (1 << 16):
                header.append(0x80 | 126)
                header += length.to_bytes(2, "big")
            else:
                header.append(0x80 | 127)
                header += length.to_bytes(8, "big")
            header += mask
            masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
            sock.sendall(bytes(header) + masked)

        def _ws_recv_exact(n: int) -> bytes:
            out = bytearray()
            while len(out) < n:
                hdr = _sock_recv_exact(2)
                opcode = hdr[0] & 0x0F
                length = hdr[1] & 0x7F
                if length == 126:
                    length = int.from_bytes(_sock_recv_exact(2), "big")
                elif length == 127:
                    length = int.from_bytes(_sock_recv_exact(8), "big")
                payload = b""
                while len(payload) < length:
                    chunk = sock.recv(length - len(payload))
                    if not chunk:
                        raise RFBConnectFailed(f"ws recv: short payload (t={_dt()})")
                    payload += chunk
                if opcode == 0x8:
                    raise RFBConnectFailed(f"ws recv: server close frame (t={_dt()})")
                out += payload
            return bytes(out[:n])

        proto = _ws_recv_exact(12)
        if not proto.startswith(b"RFB "):
            raise RFBConnectFailed(f"RFB version: got {proto!r} (t={_dt()})")
        state.log(f"rfb_click: RFB ProtocolVersion ok (t={_dt()})")
        _ws_send(b"RFB 003.008\n")
        nsec = _ws_recv_exact(1)[0]
        if nsec == 0:
            n = int.from_bytes(_ws_recv_exact(4), "big")
            reason = _ws_recv_exact(n).decode("utf-8", "replace")
            raise RFBConnectFailed(f"RFB security: {reason} (t={_dt()})")
        sec_types = _ws_recv_exact(nsec)
        if 1 not in sec_types:
            raise RFBConnectFailed(f"RFB security: no None type: {list(sec_types)} (t={_dt()})")
        _ws_send(bytes([1]))
        sec_result = int.from_bytes(_ws_recv_exact(4), "big")
        if sec_result != 0:
            raise RFBConnectFailed(f"RFB security: handshake failed result={sec_result} (t={_dt()})")
        state.log(f"rfb_click: RFB security ok (t={_dt()})")
        _ws_send(bytes([1]))  # ClientInit shared=1
        si = _ws_recv_exact(24)
        name_len = int.from_bytes(si[20:24], "big")
        if name_len > 0:
            _ = _ws_recv_exact(name_len)
        state.log(f"rfb_click: ServerInit ok (t={_dt()})")
        x16 = max(0, min(int(x), 65535))
        y16 = max(0, min(int(y), 65535))
        _ws_send(struct.pack(">BBHH", 5, 1, x16, y16))  # button down
        time.sleep(_RFB_BUTTON_HOLD_S)
        _ws_send(struct.pack(">BBHH", 5, 0, x16, y16))  # button up
        state.log(f"rfb_click: pointer events sent ok (t={_dt()})")
    except RFBConnectFailed as e:
        state.log(f"rfb_click: FAIL RFBConnectFailed: {e} (t={_dt()})")
        raise
    except (TimeoutError, OSError) as e:
        msg = f"socket error: {type(e).__name__}: {str(e)[:160]} (t={_dt()})"
        state.log(f"rfb_click: FAIL {msg}")
        raise RFBConnectFailed(msg)
    except Exception as e:
        msg = f"unexpected: {type(e).__name__}: {str(e)[:160]} (t={_dt()})"
        state.log(f"rfb_click: FAIL {msg}")
        raise RFBConnectFailed(msg)
    finally:
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
