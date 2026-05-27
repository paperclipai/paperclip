"""RFB pointer-event injection directly to x11vnc over raw TCP.

Bypasses Camoufox/Firefox's isTrusted=false trap on React-protected
buttons (e.g. Figma's "Continue with Google" button on the login page).
Coords are Xvfb-native (1920x1080). See memory entry
`camoufox_istrusted_false_rfb_workaround.md` for the durable pattern.

Historical note: this used to go through websockify on :6080 wrapping
the RFB protocol in WebSocket frames. Live diagnosis 2026-05-25
01:00 showed that path stalling for 30s under Camoufox CPU contention
(figma.com/login active render) while a CONCURRENT direct probe to
x11vnc:5900 from the same pod completed the same handshake in 110 ms.
The single-threaded websockify select loop was the bottleneck, not
x11vnc itself. There is no reason to traffic through WebSocket for
programmatic, server-side click injection — noVNC needs WebSocket
because browsers can't open raw TCP, but Python can. Switching to
direct TCP eliminates the bottleneck.
"""

from __future__ import annotations

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
    port: int = 5900,
    connect_timeout: float = 5.0,
    op_timeout: float = 10.0,
) -> None:
    """Inject a real X PointerEvent at (x,y) directly into x11vnc over TCP.

    Bypasses Camoufox/Firefox isTrusted=false on React-protected buttons.
    Coords are Xvfb-native (1920x1080). Raises RFBConnectFailed on any
    socket/handshake/timeout error.

    Why direct TCP instead of websockify:6080? Live diagnosis
    2026-05-25 01:00 (rfb.py instrumentation PR #161) showed the
    websockify path stalling 30s in figma-bot's login flow while a
    CONCURRENT direct probe of x11vnc:5900 from the same pod
    completed the full handshake in 110 ms. websockify is single-
    threaded select-loop Python — its forwarding wedges under
    Camoufox CPU contention. We don't need WebSocket framing for
    programmatic click injection (noVNC needs it because browsers
    can't open raw TCP; we're not a browser).

    Direct TCP idle-state benchmark: ~110 ms end-to-end. The
    op_timeout=10s ceiling is generous — in practice the whole
    function should return in well under a second.
    """
    sock: socket.socket | None = None
    t0 = time.monotonic()

    def _dt() -> str:
        return f"{time.monotonic() - t0:.2f}s"

    state.log(f"rfb_click: begin xy=({x},{y}) op_timeout={op_timeout}s")
    try:
        sock = socket.create_connection((host, port), timeout=connect_timeout)
        sock.settimeout(op_timeout)
        state.log(f"rfb_click: connected to {host}:{port} (t={_dt()})")

        def _recv_exact(n: int) -> bytes:
            out = bytearray()
            while len(out) < n:
                chunk = sock.recv(n - len(out))
                if not chunk:
                    raise RFBConnectFailed(f"recv: socket closed mid-stream (t={_dt()})")
                out += chunk
            return bytes(out)

        proto = _recv_exact(12)
        if not proto.startswith(b"RFB "):
            raise RFBConnectFailed(f"RFB version: got {proto!r} (t={_dt()})")
        state.log(f"rfb_click: RFB ProtocolVersion ok (t={_dt()})")
        sock.sendall(b"RFB 003.008\n")

        nsec = _recv_exact(1)[0]
        if nsec == 0:
            n = int.from_bytes(_recv_exact(4), "big")
            reason = _recv_exact(n).decode("utf-8", "replace")
            raise RFBConnectFailed(f"RFB security: {reason} (t={_dt()})")
        sec_types = _recv_exact(nsec)
        if 1 not in sec_types:
            raise RFBConnectFailed(f"RFB security: no None type: {list(sec_types)} (t={_dt()})")
        sock.sendall(bytes([1]))
        sec_result = int.from_bytes(_recv_exact(4), "big")
        if sec_result != 0:
            raise RFBConnectFailed(f"RFB security: handshake failed result={sec_result} (t={_dt()})")
        state.log(f"rfb_click: RFB security ok (t={_dt()})")

        sock.sendall(bytes([1]))  # ClientInit shared=1
        si = _recv_exact(24)
        name_len = int.from_bytes(si[20:24], "big")
        if name_len > 0:
            _ = _recv_exact(name_len)
        state.log(f"rfb_click: ServerInit ok (t={_dt()})")

        x16 = max(0, min(int(x), 65535))
        y16 = max(0, min(int(y), 65535))
        sock.sendall(struct.pack(">BBHH", 5, 1, x16, y16))  # button down
        time.sleep(_RFB_BUTTON_HOLD_S)
        sock.sendall(struct.pack(">BBHH", 5, 0, x16, y16))  # button up
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
