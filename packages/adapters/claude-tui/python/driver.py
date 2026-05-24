#!/usr/bin/env python3
"""Integrated TUI driver for Claude Code v2.1.114.

Composes the four spike modules into a single orchestrator:

    capture.py         -- PTY transport + pyte rendering
    turn_detection.py  -- ready/busy/modal/streaming classifier
    modal_handler.py   -- permission modal parser + policy decision
    status_parser.py   -- welcome / footer / usage / status overlays

`ClaudeTuiDriver` exposes a small synchronous API:

    with ClaudeTuiDriver(cwd=..., policy="auto_approve") as drv:
        drv.start()
        r1 = drv.send_turn("tell me a joke")
        r2 = drv.send_turn("remember 73")
        ...
        sid = drv.get_session_id()

Internals of `send_turn` are documented in-line; the high-level loop is:

    1. Submit prompt with CR.
    2. Poll the screen via capture.read_until with a predicate that runs
       detect_turn_state + detect_modal on every byte chunk.
    3. On modal: ask the policy module for keystrokes, send them, log it.
    4. On ready (after we've seen busy at least once): turn done.
    5. Hard timeout / dead child: bail.
    6. Optionally poll /usage and ESC, capturing session %.

Run as `python driver.py` for the three live e2e scenarios.
"""
from __future__ import annotations

import logging
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

# Local imports -- spike modules are siblings.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from capture import ClaudeTuiSession, Snapshot  # noqa: E402
from turn_detection import (  # noqa: E402
    detect_turn_state as _raw_detect_turn_state,
    TurnState,
    RE_ASSISTANT,
    RE_INPUT_FILLED,
)


def _trim_trailing_blanks(text: str) -> str:
    """pyte fills the bottom of the screen with empty rows; the turn-state
    classifier looks at the last 12 lines, so on a 60-row screen with a
    25-line transcript the footer (which lives at the bottom of the rendered
    UI but ABOVE 30+ empty rows) gets missed entirely. Strip trailing blanks
    so the classifier's STATUS_TAIL_LINES window actually contains the
    footer line."""
    lines = text.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)


def detect_turn_state(visible: str, history: str, prev: Optional[TurnState] = None) -> TurnState:
    return _raw_detect_turn_state(_trim_trailing_blanks(visible), history, prev=prev)
from modal_handler import (  # noqa: E402
    detect_modal,
    decide_keys,
    EscalationRequired,
    ModalState,
)
from status_parser import parse_usage_overlay, parse_status_overlay  # noqa: E402


_log = logging.getLogger("driver")


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class TurnResult:
    success: bool
    response_text: str
    full_transcript: str
    modals_handled: list[dict] = field(default_factory=list)
    usage_pct_after: Optional[int] = None
    elapsed_sec: float = 0.0
    exit_reason: str = "complete"  # complete | timeout | child_dead | escalation


# ---------------------------------------------------------------------------
# Response extraction
# ---------------------------------------------------------------------------

# A line that starts a user message echo: "❯ <something>"
_USER_ECHO_RE = re.compile(r"(?m)^\s*❯\s+(?P<text>\S.*?)\s*$")
# A line that starts an assistant content block: "● <text>"
_ASSISTANT_HEAD_RE = re.compile(r"(?m)^(?P<indent>\s*)●\s+(?P<text>.*?)\s*$")
# Tool-output sub-marker: "  ⎿  ..."
_TOOL_OUTPUT_RE = re.compile(r"(?m)^\s*⎿\s")
# Spinner-style "Doing X… (ctrl+o to expand)" status lines
_SPINNER_NOISE_RE = re.compile(
    r"(?m)^\s*"
    r"(?:[\u2700-\u27BF\u2500-\u259F\u25A0-\u25FF\u2800-\u28FF*·●▪◆✦✧✶✷✸✺✻✽\u2022●]\s+)?"
    r"[A-Z][A-Za-z][A-Za-z0-9 ]{0,40}….*$"
)
# A "Read N file..." or "Listing N directory..." status line that the TUI
# prints inline (without ● prefix) as a tool-progress marker. These often
# survive past the tool call and look like assistant output.
_TOOL_PROGRESS_RE = re.compile(
    r"(?m)^\s*(?:Read|Listed|Listing|Reading|Edited|Wrote|Searched|Fetched|Ran)\s+\d+\s+\w+.*?\(ctrl\+o to expand\)\s*$"
)
# "✻ Churned for 58s" / "● Churned for 12s" timer summary lines.
_TIMER_RE = re.compile(r"(?m)^\s*[\u2700-\u27BF*·●▪◆✦✧✶✷✸✺✻✽]\s+Churned for\s+\d+s\s*$")
_HORIZONTAL_RE = re.compile(r"^[─━\-=_]{20,}\s*$")


def _strip_box_drawing(text: str) -> str:
    """Drop banner box-drawing lines and the input rule lines so the response
    extractor doesn't catch borders as content."""
    out: list[str] = []
    for ln in text.splitlines():
        s = ln.rstrip()
        if not s:
            out.append("")
            continue
        if _HORIZONTAL_RE.match(s.strip()):
            continue
        # Banner box top/sides/bottom (heavy box-drawing).
        if s.strip().startswith(("│", "╭", "╰", "║", "╔", "╚")) or s.strip().endswith(("│", "╮", "╯", "║", "╗", "╝")):
            continue
        out.append(s)
    return "\n".join(out)


def extract_response_text(
    transcript: str,
    prompt: str,
) -> str:
    """Best-effort: pull the text between the last echo of `prompt`
    (rendered as `❯ <prompt>`) and the next user echo (or the input box).

    Strategy:
      1. Strip the box-drawing banner so it doesn't confuse the search.
      2. Find the LAST occurrence of `❯ <first chars of prompt>` in the
         cleaned text.
      3. From there, walk forward and collect:
           - lines starting with `●` (assistant content head)
           - continuation lines indented at least 2 spaces (typical render)
         Stop on:
           - the next `❯ ...` line that is NOT a tool-output marker
           - the input-box separator (long ─── line — already stripped)
           - end-of-text.
      4. Drop spinner / "Doing X…" status lines and tool-output ⎿ lines.
      5. Strip the leading `●` and dedent.

    Honest caveats (see report):
      - If the response is very long it scrolls off the visible area and is
        only in pyte's history, which we still get via `history_text`.
      - If the response contains a line that itself starts with `❯`, our
        terminator heuristic will truncate early. We've never observed
        Claude output a `❯` glyph, so this is theoretical.
      - We do NOT diff against a pre-turn snapshot. We could; we don't.
    """
    text = _strip_box_drawing(transcript)

    # Find the last "❯ <prompt prefix>" line. We anchor on the first 40 chars
    # of the prompt to tolerate wrapping (long prompts wrap; first chunk
    # always survives).
    needle = prompt.strip()[:40]
    # Escape regex chars but allow the line to have leading whitespace.
    pat = re.compile(r"(?m)^\s*❯\s+" + re.escape(needle))
    matches = list(pat.finditer(text))
    if not matches:
        return ""
    start_idx = matches[-1].end()

    # Walk forward collecting candidate lines.
    rest = text[start_idx:]
    lines = rest.splitlines()
    # Skip the trailing partial line we landed inside.
    if lines and lines[0].strip() == "":
        lines = lines[1:]

    collected: list[str] = []
    in_assistant_block = False
    for ln in lines:
        s = ln.rstrip()
        # Terminate on next user echo.
        if re.match(r"^\s*❯\s+\S", s) and not _TOOL_OUTPUT_RE.match(s):
            break
        # Terminate on an empty input box "❯" (re-focused prompt).
        if re.match(r"^\s*❯\s*$", s):
            break

        # Drop "Churned for 12s" timer lines.
        if _TIMER_RE.match(s):
            continue
        # Drop "Read 1 file (ctrl+o to expand)" inline progress lines.
        if _TOOL_PROGRESS_RE.match(s):
            continue

        # Start (or continue) an assistant block.
        m = _ASSISTANT_HEAD_RE.match(s)
        if m:
            in_assistant_block = True
            text_part = m.group("text").strip()
            # Skip spinner-only "● Doing X…" lines.
            if _SPINNER_NOISE_RE.match(text_part):
                continue
            # Skip "● Churned for Xs" timer lines.
            if re.match(r"Churned for\s+\d+s\s*$", text_part):
                continue
            if text_part:
                collected.append(text_part)
            continue

        if not in_assistant_block:
            # Skip "Reading 1 file…" status lines and tool-output before the
            # first ● content block.
            continue

        # Tool output sub-block (⎿) inside an assistant block: skip.
        if _TOOL_OUTPUT_RE.match(s):
            continue

        # Spinner / busy noise.
        if _SPINNER_NOISE_RE.match(s):
            continue

        # Blank line ends the block IF we already have content; otherwise
        # absorb it (claude often inserts blanks before the real text).
        if not s.strip():
            if collected:
                # A blank inside the block ends the current paragraph but
                # may be followed by tool output then more text. Don't break
                # outright; keep going but record the blank.
                collected.append("")
            continue

        # Continuation line of an assistant block. Dedent two spaces if
        # present (claude indents continuations with two spaces).
        if s.startswith("  "):
            collected.append(s[2:])
        else:
            collected.append(s)

    # Trim trailing blanks.
    while collected and not collected[-1].strip():
        collected.pop()
    return "\n".join(collected).strip()


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


class ClaudeTuiDriver:
    """High-level orchestrator: prompt -> response, with modal handling and
    usage polling. Owns a single `ClaudeTuiSession` for the lifetime of the
    driver instance.
    """

    # Tunables (kept conservative; the modules can be retuned later).
    POLL_QUIET_SEC = 0.6           # max gap between bytes before we re-check state
    READY_DWELL_SEC = 0.8          # how long ready must persist before we declare done
    BUSY_OBSERVATION_REQUIRED = True
    POST_MODAL_GRACE_SEC = 0.4     # after sending modal keys, give the TUI time to repaint
    USAGE_OVERLAY_TIMEOUT = 8.0
    USAGE_POLL_QUIET_SEC = 1.2
    SETTLE_QUIET_SEC = 2.5

    def __init__(
        self,
        cwd: str,
        policy: str = "auto_approve",
        poll_usage: bool = True,
        *,
        cols: int = 200,
        rows: int = 60,
        byte_archive_path: Optional[str] = None,
    ):
        self.cwd = cwd
        self.policy = policy
        self.poll_usage = poll_usage
        self._session = ClaudeTuiSession(
            cwd=cwd,
            cols=cols,
            rows=rows,
            byte_archive_path=byte_archive_path,
        )
        self._started = False

    # ----------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._started:
            return
        self._session.start()
        # Give the welcome banner a beat past capture's own settle.
        self._session.read_until(
            predicate=lambda v, h: False,
            quiet_sec=self.SETTLE_QUIET_SEC,
            hard_timeout=10.0,
        )
        self._started = True

    def close(self) -> None:
        self._session.close()
        self._started = False

    def __enter__(self) -> "ClaudeTuiDriver":
        return self

    def __exit__(self, *a) -> None:
        self.close()

    # -------------------------------------------------------- session info

    def get_session_id(self) -> Optional[str]:
        """Open `/status`, parse session_id, dismiss with ESC. Returns None
        if the overlay never appears or has no session_id."""
        if not self._started:
            return None
        try:
            self._session.write_keys("/status")
            time.sleep(0.25)
            self._session.write_keys("\r")
            res = self._session.read_until(
                predicate=lambda v, h: "Session ID" in v or "Session ID" in h,
                quiet_sec=1.0,
                hard_timeout=self.USAGE_OVERLAY_TIMEOUT,
            )
            info = parse_status_overlay(res.snapshot.visible_text)
            sid = info.session_id if info else None
        finally:
            # Always try to dismiss with ESC.
            try:
                self._session.write_keys("\x1b")
                self._session.read_until(
                    predicate=lambda v, h: False,
                    quiet_sec=0.8,
                    hard_timeout=3.0,
                )
            except Exception:
                pass
        return sid

    # --------------------------------------------------------- core turn

    def send_turn(self, prompt: str, *, hard_timeout: float = 120.0) -> TurnResult:
        if not self._started:
            raise RuntimeError("driver not started; call start() first")

        t_start = time.monotonic()
        modals_handled: list[dict] = []
        seen_busy = False

        # Submit the prompt. A short pause between the text and the CR
        # avoids races where the TUI hasn't finished echoing the prompt
        # before we send the newline.
        self._session.write_keys(prompt)
        time.sleep(0.3)
        self._session.write_keys("\r")

        # State container the predicate updates as a side-channel.
        # We use a 1-element list because the predicate must be a plain
        # callable returning bool.
        latest: dict = {
            "snapshot": None,
            "turn_state": None,
            "modal": None,
        }

        def predicate(visible: str, history: str) -> bool:
            nonlocal seen_busy
            ts = detect_turn_state(visible, history, prev=latest["turn_state"])
            modal = detect_modal(visible) if ts.is_in_modal else None
            latest["turn_state"] = ts
            latest["modal"] = modal
            if ts.is_thinking or ts.is_streaming or ts.is_in_modal:
                seen_busy = True
            # Stop the read_until when either:
            #   - a modal needs handling, or
            #   - we're ready AND we have observed busy at least once.
            if modal is not None:
                return True
            if ts.is_ready_for_input and (seen_busy or not self.BUSY_OBSERVATION_REQUIRED):
                return True
            return False

        exit_reason = "complete"
        deadline = t_start + hard_timeout

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                exit_reason = "timeout"
                break
            res = self._session.read_until(
                predicate=predicate,
                quiet_sec=self.POLL_QUIET_SEC,
                hard_timeout=remaining,
            )

            if res.exit_reason == "child_dead":
                exit_reason = "child_dead"
                break
            if res.exit_reason == "timeout":
                exit_reason = "timeout"
                break

            modal = latest["modal"]
            ts = latest["turn_state"]

            if modal is not None:
                # Decide and send keys.
                try:
                    keys = decide_keys(modal, self.policy)
                except EscalationRequired:
                    exit_reason = "escalation"
                    modals_handled.append({
                        "kind": modal.kind,
                        "action": "escalate",
                        "key_sent": None,
                        "title": modal.title,
                    })
                    break

                action = self._semantic_for_keys(modal, keys)
                modals_handled.append({
                    "kind": modal.kind,
                    "action": action,
                    "key_sent": keys,
                    "title": modal.title,
                })

                self._session.write_keys(keys)
                # Wait for modal to disappear before resuming the main loop.
                # This guards against a re-detection of the same modal in
                # the in-flight bytes that pyte hasn't drained yet.
                time.sleep(self.POST_MODAL_GRACE_SEC)
                self._session.read_until(
                    predicate=lambda v, h: detect_modal(v) is None,
                    quiet_sec=self.POLL_QUIET_SEC,
                    hard_timeout=min(5.0, max(0.5, deadline - time.monotonic())),
                )
                # Reset state and continue the outer loop.
                latest["modal"] = None
                continue

            if ts is not None and ts.is_ready_for_input and seen_busy:
                # Confirm ready persists; protects against momentary
                # ready-flickers between tool calls.
                stable_until = time.monotonic() + self.READY_DWELL_SEC
                stable = True
                while time.monotonic() < stable_until:
                    sub = self._session.read_until(
                        predicate=lambda v, h: (
                            detect_modal(v) is not None
                            or not bool(detect_turn_state(v, h, prev=ts).is_ready_for_input)
                        ),
                        quiet_sec=0.4,
                        hard_timeout=max(0.1, stable_until - time.monotonic()),
                    )
                    if sub.exit_reason == "child_dead":
                        exit_reason = "child_dead"
                        stable = False
                        break
                    if sub.exit_reason == "predicate":
                        # Something interrupted ready -- back to outer loop.
                        stable = False
                        break
                    # quiet or timeout: keep waiting until dwell expires.
                if not stable and exit_reason != "child_dead":
                    continue
                if exit_reason == "child_dead":
                    break
                exit_reason = "complete"
                break

            # Otherwise: read_until returned without progress (quiet). Loop.

        # Capture final transcript snapshot for response extraction.
        snap = self._session.snapshot()
        full_transcript = snap.history_text or snap.visible_text
        response_text = extract_response_text(full_transcript, prompt) if exit_reason == "complete" else ""

        usage_pct: Optional[int] = None
        if self.poll_usage and exit_reason == "complete":
            usage_pct = self._poll_usage_pct()

        return TurnResult(
            success=(exit_reason == "complete"),
            response_text=response_text,
            full_transcript=full_transcript,
            modals_handled=modals_handled,
            usage_pct_after=usage_pct,
            elapsed_sec=time.monotonic() - t_start,
            exit_reason=exit_reason,
        )

    # ----------------------------------------------------------- helpers

    def _semantic_for_keys(self, modal: ModalState, keys: str) -> str:
        """Map the keystroke we sent back to a semantics label for logging."""
        if keys == "\x1b":
            return "cancel"
        for opt in modal.options:
            if opt.key_to_select == keys:
                return opt.semantics
        return "unknown"

    def _poll_usage_pct(self) -> Optional[int]:
        """Open /usage, parse session %, dismiss with ESC."""
        try:
            self._session.write_keys("/usage")
            time.sleep(0.25)
            self._session.write_keys("\r")
            res = self._session.read_until(
                predicate=lambda v, h: (
                    "Current session" in v
                    and re.search(r"\d+\s*%\s*used", v) is not None
                ),
                quiet_sec=self.USAGE_POLL_QUIET_SEC,
                hard_timeout=self.USAGE_OVERLAY_TIMEOUT,
            )
            info = parse_usage_overlay(res.snapshot.visible_text)
            pct = info.session_pct_used if info else None
        except Exception as exc:  # pragma: no cover - defensive
            _log.warning("usage poll failed: %s", exc)
            pct = None
        finally:
            try:
                self._session.write_keys("\x1b")
                self._session.read_until(
                    predicate=lambda v, h: False,
                    quiet_sec=0.7,
                    hard_timeout=3.0,
                )
            except Exception:
                pass
        return pct


# ---------------------------------------------------------------------------
# E2E
# ---------------------------------------------------------------------------


def _run_e2e() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    cwd = tempfile.mkdtemp(prefix="driver-e2e-")
    print(f"[e2e] cwd = {cwd}")
    archive = str(Path(cwd) / "driver-e2e.bin.gz")

    t_total = time.monotonic()
    failures: list[str] = []

    def _verdict(name: str, ok: bool, payload: dict) -> None:
        tag = "PASS" if ok else "FAIL"
        print(f"\n[{tag}] {name}")
        # Compact result dump.
        compact = {
            k: (
                (v[:240] + "…(truncated)…") if isinstance(v, str) and len(v) > 240 else v
            )
            for k, v in payload.items()
        }
        for k, v in compact.items():
            print(f"   {k} = {v!r}")
        if not ok:
            failures.append(name)

    try:
        with ClaudeTuiDriver(
            cwd=cwd, policy="auto_approve", poll_usage=True,
            byte_archive_path=archive,
        ) as drv:
            drv.start()

            # ---- Scenario 1: short joke ----------------------------------
            print("\n[e2e] >> scenario 1: joke")
            r1 = drv.send_turn(
                "tell me a one-line joke",
                hard_timeout=60.0,
            )
            ok1 = (
                r1.success
                and len(r1.response_text.strip()) >= 5
                and len(r1.modals_handled) == 0
                and (r1.usage_pct_after is None or r1.usage_pct_after >= 0)
            )
            _verdict("scenario_1_joke", ok1, {
                **asdict(r1),
                "full_transcript": f"<{len(r1.full_transcript)} chars>",
            })

            # ---- Scenario 2: memory (two turns) --------------------------
            print("\n[e2e] >> scenario 2a: remember 73")
            r2a = drv.send_turn(
                "remember the number 73",
                hard_timeout=60.0,
            )
            ok2a = r2a.success
            _verdict("scenario_2a_remember", ok2a, {
                **asdict(r2a),
                "full_transcript": f"<{len(r2a.full_transcript)} chars>",
            })

            print("\n[e2e] >> scenario 2b: recall")
            r2b = drv.send_turn(
                "what number did i ask you to remember?",
                hard_timeout=60.0,
            )
            ok2b = r2b.success and "73" in r2b.response_text
            _verdict("scenario_2b_recall", ok2b, {
                **asdict(r2b),
                "full_transcript": f"<{len(r2b.full_transcript)} chars>",
            })

            # ---- Scenario 3: permission modal ----------------------------
            print("\n[e2e] >> scenario 3: read /etc/hosts (triggers modal)")
            r3 = drv.send_turn(
                "Read /etc/hosts using the Read tool, then summarize it in one sentence",
                hard_timeout=120.0,
            )
            has_read_approve = any(
                m.get("kind") == "read" and m.get("action") in ("approve", "approve_always")
                for m in r3.modals_handled
            )
            # Accept any common hosts-file-ish word. The model phrases the
            # summary differently each run (localhost / loopback / 127.0.0.1
            # / hosts file mapping).
            mentions_localhost = bool(re.search(
                r"localhost|127\.0\.0\.1|loopback|hosts file|hostname mapping",
                r3.response_text,
                re.I,
            ))
            ok3 = r3.success and has_read_approve and mentions_localhost
            _verdict("scenario_3_modal_read", ok3, {
                **asdict(r3),
                "full_transcript": f"<{len(r3.full_transcript)} chars>",
            })

            print(f"\n[e2e] session_id = {drv.get_session_id()!r}")

    except Exception as exc:
        failures.append(f"uncaught: {exc!r}")
        print(f"\n[e2e] UNCAUGHT EXCEPTION: {exc!r}")
        import traceback
        traceback.print_exc()

    elapsed = time.monotonic() - t_total
    print(f"\n[e2e] DONE in {elapsed:.1f}s -- {len(failures)} failure(s)")
    for f in failures:
        print(f"  FAIL: {f}")
    print(f"[e2e] byte archive: {archive}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(_run_e2e())
