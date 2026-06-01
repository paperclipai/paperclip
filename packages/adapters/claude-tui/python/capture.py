#!/usr/bin/env python3
"""Transport + capture layer for the Claude Code TUI driven through a PTY.

This module is intentionally narrow: it spawns `claude` under a pseudo-terminal,
ferries bytes in and out, decodes them with a stateful UTF-8 incremental
decoder, and renders them through a `pyte.HistoryScreen` so callers can read
both the current viewport and the scrollback as plain text.

It does NOT know about modals, turn completion heuristics beyond
predicate / quiet / hard-timeout, session IDs, or any other claude-specific
state. Those concerns live in higher layers.
"""
from __future__ import annotations

import codecs
import errno
import gzip
import logging
import os
import select
import signal
import struct
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Literal, Optional

import ptyprocess
import pyte


# ---------------------------------------------------------------------------
# Public dataclasses
# ---------------------------------------------------------------------------


@dataclass
class Snapshot:
    visible_text: str
    history_text: str
    cursor_row: int
    cursor_col: int
    captured_at: float


@dataclass
class ReadResult:
    snapshot: Snapshot
    bytes_read: int
    elapsed_sec: float
    exit_reason: Literal["predicate", "quiet", "timeout", "child_dead"]


# ---------------------------------------------------------------------------
# Environment scrubbing
# ---------------------------------------------------------------------------

_STRIP_EXACT = {
    "CLAUDE_PROJECT_DIR",
}

_STRIP_PREFIXES = ("CLAUDECODE", "CLAUDE_CODE_")


def _build_env(
    cols: int,
    rows: int,
    overrides: Optional[dict[str, str]],
) -> dict[str, str]:
    env: dict[str, str] = {}
    for k, v in os.environ.items():
        if k in _STRIP_EXACT:
            continue
        if any(k.startswith(p) for p in _STRIP_PREFIXES):
            continue
        env[k] = v
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(cols)
    env["LINES"] = str(rows)
    if overrides:
        env.update(overrides)
    return env


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------


def _render_history_line(line) -> str:
    """pyte history lines are dict-like {col_idx: Char}. Return as text."""
    if not line:
        return ""
    # `line` may be a dict (StaticDefaultDict) or already a sequence.
    try:
        max_col = max(line.keys())
    except AttributeError:
        # Already a sequence of Char
        return "".join(getattr(ch, "data", " ") for ch in line).rstrip()
    out_chars: list[str] = []
    for col in range(max_col + 1):
        ch = line.get(col)
        if ch is None:
            out_chars.append(" ")
        else:
            out_chars.append(getattr(ch, "data", " ") or " ")
    return "".join(out_chars).rstrip()


def _render_visible(screen: pyte.Screen) -> str:
    return "\n".join(line.rstrip() for line in screen.display)


def _render_history(screen: pyte.HistoryScreen) -> str:
    """Concatenate scrolled-off history (top) + current viewport + bottom."""
    parts: list[str] = []
    for line in list(screen.history.top):
        parts.append(_render_history_line(line))
    parts.extend(line.rstrip() for line in screen.display)
    for line in list(screen.history.bottom):
        parts.append(_render_history_line(line))
    # Strip pure-empty trailing lines but keep interior blanks.
    while parts and parts[-1] == "":
        parts.pop()
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Session
# ---------------------------------------------------------------------------


_log = logging.getLogger("capture")


class ClaudeTuiSession:
    """Spawn and drive Claude Code's TUI through a real PTY.

    The class is a context manager; `close()` is idempotent and safe to call
    from `__exit__` even after exceptions in the body.
    """

    INITIAL_SETTLE_QUIET_SEC = 2.0
    INITIAL_SETTLE_TIMEOUT_SEC = 15.0
    READ_CHUNK = 4096
    SELECT_TICK_SEC = 0.25

    def __init__(
        self,
        *,
        cwd: str,
        env_overrides: Optional[dict[str, str]] = None,
        cols: int = 200,
        rows: int = 60,
        history_lines: int = 5000,
        byte_archive_path: Optional[str] = None,
        claude_argv: Optional[list[str]] = None,
    ):
        self._cwd = cwd
        self._env_overrides = dict(env_overrides) if env_overrides else None
        self._cols = cols
        self._rows = rows
        self._history_lines = history_lines
        self._byte_archive_path = byte_archive_path
        self._argv = list(claude_argv) if claude_argv else ["claude"]

        self._pty: Optional[ptyprocess.PtyProcess] = None
        self._screen: Optional[pyte.HistoryScreen] = None
        self._stream: Optional[pyte.Stream] = None
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        self._decoder_replace_count = 0

        self._archive_fp: Optional[gzip.GzipFile] = None
        self._closed = False
        self._exit_status: Optional[int] = None
        self._exit_signal: Optional[int] = None

    # ------------------------------------------------------------------ env

    def _resolved_env(self) -> dict[str, str]:
        return _build_env(self._cols, self._rows, self._env_overrides)

    # ----------------------------------------------------------- archiving

    def _archive_chunk(self, raw: bytes) -> None:
        if not raw or self._byte_archive_path is None:
            return
        try:
            if self._archive_fp is None:
                self._archive_fp = gzip.open(self._byte_archive_path, "wb")
            self._archive_fp.write(struct.pack(">I", len(raw)))
            self._archive_fp.write(raw)
            self._archive_fp.flush()
        except Exception as exc:  # pragma: no cover - defensive
            _log.warning("byte-archive write failed: %s", exc)

    def _close_archive(self) -> None:
        if self._archive_fp is not None:
            try:
                self._archive_fp.close()
            except Exception:
                pass
            self._archive_fp = None

    # ---------------------------------------------------------- spawn/exit

    def start(self) -> None:
        if self._pty is not None:
            raise RuntimeError("session already started")
        try:
            self._screen = pyte.HistoryScreen(
                self._cols, self._rows,
                history=self._history_lines, ratio=0.5,
            )
            self._stream = pyte.Stream(self._screen)
            env = self._resolved_env()
            self._pty = ptyprocess.PtyProcess.spawn(
                self._argv,
                cwd=self._cwd,
                env=env,
                dimensions=(self._rows, self._cols),
            )
            # Drain the banner until the TUI quiets, but don't fail hard if
            # nothing arrives in time -- the caller can decide what counts as
            # ready via their first `read_until` predicate.
            try:
                self.read_until(
                    predicate=lambda visible, history: False,
                    quiet_sec=self.INITIAL_SETTLE_QUIET_SEC,
                    hard_timeout=self.INITIAL_SETTLE_TIMEOUT_SEC,
                )
            except TimeoutError:
                # Re-raise with a clearer message.
                raise TimeoutError(
                    "claude TUI failed to emit any output during initial settle"
                )
        except BaseException:
            # Make sure we don't leak the PTY if anything explodes during start.
            self.close()
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        pty = self._pty
        if pty is not None:
            # Polite shutdown sequence: Ctrl-C -> /exit -> SIGTERM -> SIGKILL.
            try:
                if pty.isalive():
                    try:
                        pty.write(b"\x03")  # Ctrl-C
                    except Exception:
                        pass
                    time.sleep(0.1)
                    try:
                        pty.write(b"/exit\r")
                    except Exception:
                        pass
                    deadline = time.monotonic() + 2.0
                    while time.monotonic() < deadline and pty.isalive():
                        time.sleep(0.05)
                    if pty.isalive():
                        try:
                            pty.terminate(force=False)  # SIGHUP/SIGINT
                        except Exception:
                            pass
                        grace = time.monotonic() + 2.0
                        while time.monotonic() < grace and pty.isalive():
                            time.sleep(0.05)
                    if pty.isalive():
                        try:
                            pty.kill(signal.SIGKILL)
                        except Exception:
                            pass
                        # Reap so we don't leave a zombie + an open fd.
                        for _ in range(20):
                            if not pty.isalive():
                                break
                            time.sleep(0.05)
            finally:
                # Capture exit status if we can.
                try:
                    self._exit_status = pty.exitstatus
                    self._exit_signal = pty.signalstatus
                except Exception:
                    pass
                # Close the PTY file descriptor unconditionally.
                try:
                    pty.close(force=True)
                except Exception:
                    try:
                        os.close(pty.fd)
                    except Exception:
                        pass
        self._pty = None
        self._close_archive()

    # ------------------------------------------------------- context mgr

    def __enter__(self) -> "ClaudeTuiSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    # ------------------------------------------------------- liveness

    def is_alive(self) -> bool:
        pty = self._pty
        if pty is None:
            return False
        try:
            if not pty.isalive():
                self._exit_status = pty.exitstatus
                self._exit_signal = pty.signalstatus
                return False
        except Exception:
            return False
        # Non-blocking waitpid sanity check.
        try:
            wpid, status = os.waitpid(pty.pid, os.WNOHANG)
            if wpid == pty.pid:
                # Child reaped; refresh status fields if possible.
                if os.WIFEXITED(status):
                    self._exit_status = os.WEXITSTATUS(status)
                if os.WIFSIGNALED(status):
                    self._exit_signal = os.WTERMSIG(status)
                return False
        except ChildProcessError:
            return False
        except OSError as exc:
            if exc.errno == errno.ECHILD:
                return False
        return True

    @property
    def exit_status(self) -> Optional[int]:
        return self._exit_status

    @property
    def exit_signal(self) -> Optional[int]:
        return self._exit_signal

    @property
    def pid(self) -> Optional[int]:
        return self._pty.pid if self._pty else None

    @property
    def fd(self) -> Optional[int]:
        return self._pty.fd if self._pty else None

    # -------------------------------------------------------- resizing

    def resize(self, rows: int, cols: int) -> None:
        self._rows = rows
        self._cols = cols
        if self._pty is not None:
            try:
                self._pty.setwinsize(rows, cols)
            except Exception as exc:
                _log.warning("setwinsize failed: %s", exc)
        if self._screen is not None:
            try:
                self._screen.resize(rows, cols)
            except Exception as exc:
                _log.warning("screen.resize failed: %s", exc)

    # ---------------------------------------------------------- writing

    def write_keys(self, data: str) -> None:
        if self._pty is None:
            raise RuntimeError("session not started")
        payload = data.encode("utf-8")
        # Write in modest slices to avoid blocking a slow tty.
        view = memoryview(payload)
        offset = 0
        while offset < len(view):
            n = self._pty.write(bytes(view[offset:offset + 1024]))
            if n is None:
                # ptyprocess.write returns bytes written; defensive fallback.
                offset += min(1024, len(view) - offset)
            else:
                offset += n if isinstance(n, int) and n > 0 else (len(view) - offset)

    # ---------------------------------------------------------- reading

    def _decode(self, raw: bytes) -> str:
        try:
            return self._decoder.decode(raw)
        except UnicodeDecodeError:
            # Fall back to a replace-decoder for THIS chunk only, then keep
            # going with the strict one (its internal buffer is gone but
            # subsequent chunks will start fresh from a UTF-8 boundary
            # because we've consumed everything up to the bad byte).
            self._decoder_replace_count += 1
            _log.warning(
                "utf-8 decode error; falling back to errors='replace' (count=%d)",
                self._decoder_replace_count,
            )
            self._decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
            return raw.decode("utf-8", errors="replace")

    def _make_snapshot(self) -> Snapshot:
        screen = self._screen
        assert screen is not None
        return Snapshot(
            visible_text=_render_visible(screen),
            history_text=_render_history(screen),
            cursor_row=screen.cursor.y,
            cursor_col=screen.cursor.x,
            captured_at=time.monotonic(),
        )

    def snapshot(self) -> Snapshot:
        if self._screen is None:
            raise RuntimeError("session not started")
        return self._make_snapshot()

    def read_until(
        self,
        *,
        predicate: Callable[[str, str], bool],
        quiet_sec: float = 4.0,
        hard_timeout: float = 90.0,
    ) -> ReadResult:
        if self._pty is None or self._stream is None or self._screen is None:
            raise RuntimeError("session not started")

        start = time.monotonic()
        deadline = start + hard_timeout
        last_recv = start
        bytes_read = 0
        exit_reason: Literal["predicate", "quiet", "timeout", "child_dead"] = "timeout"

        while True:
            now = time.monotonic()
            if now >= deadline:
                exit_reason = "timeout"
                break
            if now - last_recv >= quiet_sec:
                exit_reason = "quiet"
                break

            tick = min(self.SELECT_TICK_SEC,
                       max(0.01, deadline - now),
                       max(0.01, quiet_sec - (now - last_recv)))
            try:
                r, _, _ = select.select([self._pty.fd], [], [], tick)
            except (OSError, ValueError):
                # fd may have been closed under us
                if not self.is_alive():
                    exit_reason = "child_dead"
                    break
                continue

            if r:
                try:
                    raw = self._pty.read(self.READ_CHUNK)
                except EOFError:
                    raw = b""
                except OSError:
                    raw = b""
                if raw:
                    self._archive_chunk(raw)
                    bytes_read += len(raw)
                    text = self._decode(raw)
                    if text:
                        self._stream.feed(text)
                    last_recv = time.monotonic()
                    snap = self._make_snapshot()
                    try:
                        if predicate(snap.visible_text, snap.history_text):
                            exit_reason = "predicate"
                            break
                    except Exception as exc:
                        _log.warning("predicate raised %s; treating as False", exc)
                else:
                    # Empty read on a ready fd usually means EOF.
                    if not self.is_alive():
                        exit_reason = "child_dead"
                        break
            # Even when no data was ready, check liveness.
            if not self.is_alive():
                exit_reason = "child_dead"
                break

        snap = self._make_snapshot()
        return ReadResult(
            snapshot=snap,
            bytes_read=bytes_read,
            elapsed_sec=time.monotonic() - start,
            exit_reason=exit_reason,
        )


# ---------------------------------------------------------------------------
# Self-tests
# ---------------------------------------------------------------------------


def _scratch_cwd() -> str:
    import tempfile
    return tempfile.mkdtemp(prefix="capture-test-")


def _settle_after_start(s: ClaudeTuiSession, extra_quiet: float = 2.5,
                        hard: float = 12.0) -> None:
    """Give the TUI an extra moment to finish painting after start()."""
    s.read_until(
        predicate=lambda v, h: False,
        quiet_sec=extra_quiet,
        hard_timeout=hard,
    )


def _submit_prompt(s: ClaudeTuiSession, text: str) -> None:
    """Type text, pause, then send carriage return."""
    s.write_keys(text)
    time.sleep(0.4)
    s.write_keys("\r")


def _test_short_roundtrip() -> tuple[bool, str]:
    import shutil
    cwd = _scratch_cwd()
    try:
        s = ClaudeTuiSession(cwd=cwd, cols=200, rows=60)
        with s:
            s.start()
            _settle_after_start(s)
            probe = "PROBE_ABC123"
            _submit_prompt(s, f"Reply with exactly: {probe}")
            res = s.read_until(
                predicate=lambda v, h: probe in v or probe in h,
                quiet_sec=6.0,
                hard_timeout=30.0,
            )
            ok = (probe in res.snapshot.visible_text or
                  probe in res.snapshot.history_text)
            if ok:
                return True, f"got probe in {res.elapsed_sec:.1f}s ({res.exit_reason})"
            return False, (
                f"probe missing after {res.elapsed_sec:.1f}s "
                f"({res.exit_reason}, bytes={res.bytes_read})"
            )
    except Exception as exc:
        return False, f"exception: {exc!r}"
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def _test_scrollback() -> tuple[bool, str]:
    import shutil
    cwd = _scratch_cwd()
    try:
        s = ClaudeTuiSession(cwd=cwd, cols=200, rows=60, history_lines=5000)
        with s:
            s.start()
            _settle_after_start(s)
            _submit_prompt(
                s,
                "Print exactly 200 lines, each saying 'LINE_<n>' where n is "
                "1..200, one per line. Just the lines, no commentary, no "
                "markdown fences.",
            )
            # The output is long; use a generous quiet window. Predicate fires
            # early if we already see the tail.
            res = s.read_until(
                predicate=lambda v, h: ("LINE_200" in h) and ("LINE_1\n" in h or h.startswith("LINE_1") or "LINE_1 " in h),
                quiet_sec=8.0,
                hard_timeout=120.0,
            )
            h = res.snapshot.history_text
            has_first = "LINE_1\n" in h or h.startswith("LINE_1") or "LINE_1 " in h or "LINE_1\r" in h
            has_last = "LINE_200" in h
            if has_first and has_last:
                return True, (
                    f"LINE_1 and LINE_200 in history "
                    f"({res.exit_reason}, bytes={res.bytes_read}, "
                    f"elapsed={res.elapsed_sec:.1f}s)"
                )
            return False, (
                f"missing markers: LINE_1={has_first} LINE_200={has_last} "
                f"(exit={res.exit_reason}, bytes={res.bytes_read})"
            )
    except Exception as exc:
        return False, f"exception: {exc!r}"
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def _test_utf8_boundary() -> tuple[bool, str]:
    import shutil
    cwd = _scratch_cwd()
    try:
        s = ClaudeTuiSession(cwd=cwd, cols=200, rows=60)
        with s:
            s.start()
            _settle_after_start(s)
            _submit_prompt(
                s,
                "Output 10 lines of mixed emoji and CJK characters. "
                "Absolutely no English words. Just the 10 lines.",
            )
            res = s.read_until(
                predicate=lambda v, h: False,  # let quiet_sec do the work
                quiet_sec=8.0,
                hard_timeout=60.0,
            )
            text = res.snapshot.history_text
            non_ascii = [c for c in text if ord(c) > 127]
            if non_ascii:
                return True, (
                    f"{len(non_ascii)} non-ascii chars, replace-falls={s._decoder_replace_count} "
                    f"(exit={res.exit_reason})"
                )
            return False, (
                f"no non-ascii chars in history (bytes={res.bytes_read}, "
                f"exit={res.exit_reason})"
            )
    except UnicodeDecodeError as exc:
        return False, f"UnicodeDecodeError leaked: {exc!r}"
    except Exception as exc:
        return False, f"exception: {exc!r}"
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def _test_fd_hygiene() -> tuple[bool, str]:
    import shutil
    fd_dir = "/proc/self/fd"
    try:
        before = len(os.listdir(fd_dir))
    except Exception as exc:
        return False, f"cannot read {fd_dir}: {exc!r}"
    cwds: list[str] = []
    try:
        for i in range(20):
            cwd = _scratch_cwd()
            cwds.append(cwd)
            with ClaudeTuiSession(cwd=cwd, cols=120, rows=40) as s:
                s.start()
                # Don't wait long; we just need the spawn/teardown to be clean.
                s.read_until(
                    predicate=lambda v, h: False,
                    quiet_sec=0.5,
                    hard_timeout=4.0,
                )
        after = len(os.listdir(fd_dir))
        delta = after - before
        if delta <= 2:
            return True, f"fd delta={delta} (before={before}, after={after})"
        return False, f"fd delta={delta} (before={before}, after={after})"
    except Exception as exc:
        return False, f"exception: {exc!r}"
    finally:
        for d in cwds:
            shutil.rmtree(d, ignore_errors=True)


def _test_child_death() -> tuple[bool, str]:
    import shutil
    cwd = _scratch_cwd()
    try:
        s = ClaudeTuiSession(cwd=cwd, cols=200, rows=60)
        with s:
            s.start()
            _settle_after_start(s, extra_quiet=1.0, hard=8.0)
            pid = s.pid
            assert pid is not None
            os.kill(pid, signal.SIGKILL)
            t0 = time.monotonic()
            res = s.read_until(
                predicate=lambda v, h: False,
                quiet_sec=10.0,
                hard_timeout=10.0,
            )
            elapsed = time.monotonic() - t0
            if res.exit_reason == "child_dead" and elapsed < 2.0:
                return True, f"detected dead child in {elapsed:.2f}s"
            return False, (
                f"exit_reason={res.exit_reason} elapsed={elapsed:.2f}s"
            )
    except Exception as exc:
        return False, f"exception: {exc!r}"
    finally:
        shutil.rmtree(cwd, ignore_errors=True)


def _run_self_tests() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    tests = [
        ("short_roundtrip", _test_short_roundtrip),
        ("long_output_scrollback", _test_scrollback),
        ("utf8_boundary", _test_utf8_boundary),
        ("fd_hygiene", _test_fd_hygiene),
        ("child_death", _test_child_death),
    ]
    failures = 0
    for name, fn in tests:
        print(f"[capture-test] >> {name} ...", flush=True)
        t0 = time.monotonic()
        try:
            ok, msg = fn()
        except Exception as exc:
            ok, msg = False, f"uncaught exception: {exc!r}"
        dt = time.monotonic() - t0
        tag = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1
        print(f"[capture-test] {tag} {name} ({dt:.1f}s) -- {msg}", flush=True)
    print(f"[capture-test] done: {len(tests) - failures}/{len(tests)} passed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_self_tests())
