#!/usr/bin/env python3
"""Positive turn-completion detector for Claude Code v2.1.114 TUI.

This module exposes PURE classification functions. Given a snapshot of the
rendered screen (post-pyte) and the previous TurnState, classify what the TUI
is currently showing. No PTY, no I/O.

================================================================================
MARKERS FOUND (empirically captured against claude 2.1.114)
================================================================================

The TUI is divided into:
  - top region: welcome banner OR prior transcript
  - middle: latest user message (prefixed with ``❯ ``) and assistant output
    (prefixed with ``●``) interleaved with tool blocks
  - input area: a rounded box with ``❯`` glyph showing where typing lands
  - status row(s) below the input box

The two highest-confidence indicators live in the **status row** (bottom 1-2
lines after the input box). They are mutually exclusive:

  READY     →  footer contains ``? for shortcuts``
  BUSY      →  footer contains ``esc to interrupt``
  MODAL     →  the input box / status rows are replaced by a permission panel.

Concrete markers (regex / substring):

  R1. ready_footer        : substring  "? for shortcuts"
  R2. busy_footer         : substring  "esc to interrupt"
  R3. mode_indicator      : regex      r"◉\\s+\\S+\\s+·\\s+/effort"
                                       (present in both ready & busy)
  R4. spinner_label       : regex      r"(?m)^\\s*(?:[\\u2700-\\u27BF\\u2500-\\u259F"
                                       r"\\u25A0-\\u25FF\\u2800-\\u28FF*·●▪◆✦✧✶✷✸✺✻✽\\u2022]|"
                                       r"\\S{1,3})\\s+([A-Z][A-Za-z][A-Za-z0-9 ]{1,30})…"
                            ‑‑ a single-glyph prefix followed by a Capitalized
                            word ending with U+2026 ellipsis. Examples seen:
                            "✻ Hashing…", "· Drizzling…", "✽ Warping…",
                            "✶ Quantumizing…", "* Quantumizing…".
                            We REQUIRE the trailing ``…`` to avoid matching
                            "● assistant text" lines.
  R5. modal_question      : substring  "Do you want to proceed?"
  R6. modal_choice        : regex      r"(?m)^\\s*❯?\\s*1\\.\\s"  paired with
                                       r"(?m)^\\s*\\s*2\\.\\s" or "3. "
  R7. modal_footer        : substring  "Esc to cancel · Tab to amend"
  R8. input_box_glyph     : regex      r"(?m)^\\s*❯\\s*$"  -- empty input line
                                       (re-focused, ready to type)
  R9. user_msg_glyph      : regex      r"(?m)^\\s*❯\\s+\\S"  -- prior submitted
                                       prompt; appears in transcript.
  R10. assistant_glyph    : regex      r"(?m)^\\s*●\\s+\\S"  -- assistant text;
                                       presence + matching spinner-absence ⇒
                                       streaming has produced output.

Streaming detection: there is no single "streaming RIGHT NOW" marker
distinct from the spinner. We approximate ``is_streaming`` as:
   busy_footer AND ``●`` lines exist after the latest ``❯ <prompt>`` line.
i.e., assistant has already begun emitting text but the turn hasn't yielded
the input box back. ``is_thinking`` is busy_footer AND no such ``●`` block yet.

Modal precedence: if R5-R7 indicate a modal, ``is_in_modal=True`` overrides
the busy/ready footer (the footer is replaced anyway).

Confidence on each marker (after live capture validation, 2026-05-24):
  R1 ready_footer            : HIGH    (unique, stable across all idle snapshots)
  R2 busy_footer             : HIGH    (always present during spinner)
  R3 mode_indicator          : HIGH    (helps detect "TUI is alive" vs crash)
  R4 spinner_label           : MEDIUM  (glyph zoo is large; we anchor on "…")
  R5 modal_question          : HIGH    (exact phrase, seen in Bash permission)
  R6 modal_choice            : MEDIUM  (numbered choices appear in other UIs too,
                                        so we require R5 OR R7 alongside)
  R7 modal_footer            : HIGH    (unique to modal)
  R8 input_box_glyph (empty) : HIGH    (re-focus signal)
  R9 user_msg_glyph          : N/A     (used for streaming heuristic only)
  R10 assistant_glyph        : MEDIUM  (used for streaming heuristic only)

================================================================================
EDGE CASES
================================================================================
- During tool execution the spinner label may say tool-themed words
  ("Drizzling…", "Warping…") — we treat tool execution as ``is_thinking=True``
  not a separate state. The harness should rely on ``is_in_modal`` to know
  when *user* input is needed.
- During a *very* brief window between request submit and first spinner repaint,
  neither footer may be visible. We fall back to ``is_thinking=True`` if the
  bottom 8 lines contain neither READY nor MODAL markers, AND the input box
  shows the just-submitted prompt rather than empty.
- ``/help`` overlay is NOT classified as a modal — it does not block input
  and disappears on ESC. We mark it via screen text presence of "shortcuts"
  table headers but otherwise pass through to ready/busy.
- pyte preserves the spinner glyph from the LAST repaint, so even after the
  turn ends a stale label could linger in scrollback. We only look for
  spinner markers in the bottom ~12 rows of the *visible* screen, not history.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field, replace
from typing import Optional


# ------------------------------------------------------------------ markers ---

RE_READY_FOOTER = re.compile(r"\?\s+for\s+shortcuts")
RE_BUSY_FOOTER = re.compile(r"esc\s+to\s+interrupt")
RE_MODE_INDICATOR = re.compile(r"◉\s+\S+\s+·\s+/effort")

# Spinner: a short glyph prefix + Capitalized label + horizontal ellipsis (…).
# Examples: "✻ Hashing…", "· Drizzling…", "* Quantumizing…", "✽ Warping…"
# We forbid the ``❯`` and ``●`` glyphs at the start so we don't confuse the
# input prompt or assistant prefix.
RE_SPINNER = re.compile(
    r"(?m)^\s*([^\s❯●⎿│╭╰─])\s+([A-Z][A-Za-z][A-Za-z0-9 ]{0,30})…"
)

RE_MODAL_QUESTION = re.compile(r"Do you want to (?:proceed|allow|continue)")
RE_MODAL_FOOTER = re.compile(r"Esc to cancel\s+·\s+Tab to amend")
RE_MODAL_CHOICE = re.compile(r"(?m)^\s*❯?\s*1\.\s+\S")

# Empty input box: a line of just "❯" with nothing typed.
RE_INPUT_EMPTY = re.compile(r"(?m)^\s*❯\s*$")
# Filled input box: "❯ something"
RE_INPUT_FILLED = re.compile(r"(?m)^\s*❯\s+\S")
# Assistant content block (start of a response)
RE_ASSISTANT = re.compile(r"(?m)^\s*●\s+\S")

# How many trailing rows of the visible screen count as the "status area".
STATUS_TAIL_LINES = 12


# ------------------------------------------------------------------- state ---

@dataclass
class TurnState:
    is_ready_for_input: bool
    is_thinking: bool
    is_in_modal: bool
    is_streaming: bool
    spinner_label: Optional[str]
    last_changed_at: float = field(default_factory=time.monotonic)

    def _signature(self) -> tuple:
        # Fields that count as a "state change" — ignore spinner_label flicker
        # and obviously ignore last_changed_at.
        return (
            self.is_ready_for_input,
            self.is_thinking,
            self.is_in_modal,
            self.is_streaming,
        )


# ---------------------------------------------------------------- helpers ---

def _tail(text: str, n: int = STATUS_TAIL_LINES) -> str:
    lines = text.splitlines()
    return "\n".join(lines[-n:])


def _find_spinner(tail: str) -> Optional[str]:
    """Return the spinner label (without ellipsis) or None."""
    for m in RE_SPINNER.finditer(tail):
        label = m.group(2).strip()
        # Filter obvious false positives (single short word fragments from
        # transcript). Real labels we've seen are >= 5 chars and contain
        # a vowel.
        if len(label) >= 4 and re.search(r"[AEIOUaeiou]", label):
            return label
    return None


def _is_modal(text: str) -> bool:
    """Modal requires either the question phrase OR (modal footer + numbered
    choice) — choice alone is not enough since assistant output can contain
    numbered lists."""
    if RE_MODAL_QUESTION.search(text):
        return True
    if RE_MODAL_FOOTER.search(text) and RE_MODAL_CHOICE.search(text):
        return True
    return False


def _assistant_after_last_prompt(history_text: str) -> bool:
    """True if at least one assistant ``●`` block appears AFTER the most recent
    user ``❯ ...`` line. Used to distinguish 'thinking' (no output yet) from
    'streaming' (text is already appearing)."""
    lines = history_text.splitlines()
    last_prompt_idx = -1
    for i, ln in enumerate(lines):
        if RE_INPUT_FILLED.match(ln):
            # ignore the bottom input box itself (it's part of visible, not
            # history). Caller passes history_text which excludes the input
            # box; but defensively, the input box line is usually empty
            # because the turn has been submitted.
            last_prompt_idx = i
    if last_prompt_idx < 0:
        return False
    for ln in lines[last_prompt_idx + 1 :]:
        if RE_ASSISTANT.match(ln):
            return True
    return False


# ------------------------------------------------------------ public API ---

def detect_turn_state(
    screen_visible_text: str,
    history_text: str,
    prev: Optional[TurnState] = None,
) -> TurnState:
    """Classify the current TUI state.

    Parameters
    ----------
    screen_visible_text:
        The *visible* terminal screen as rendered text (e.g. ``"\\n".join(
        screen.display)`` from pyte). This is what the user is looking at
        right now — includes input box, footer, possibly modal.
    history_text:
        The transcript / scrollback area, used to differentiate
        ``is_thinking`` vs ``is_streaming``. If the caller doesn't track
        scrollback separately, pass ``screen_visible_text`` again — the
        heuristic still works because the visible screen contains the
        recent ``❯ prompt`` and ``● response`` lines.
    prev:
        The previous TurnState. Used to preserve ``last_changed_at``
        timestamps across calls where the classification is unchanged.
    """
    now = time.monotonic()
    tail = _tail(screen_visible_text)

    in_modal = _is_modal(screen_visible_text)
    ready = bool(RE_READY_FOOTER.search(tail)) and not in_modal
    busy = bool(RE_BUSY_FOOTER.search(tail)) and not in_modal
    spinner = _find_spinner(tail) if (busy or not ready) else None

    # Fallback: if neither footer detected and not a modal, but there is a
    # spinner-shaped line, treat as busy. This catches the brief window before
    # the first footer repaint after submit.
    if not ready and not busy and not in_modal and spinner is not None:
        busy = True

    # Streaming: busy AND assistant content visible after the latest prompt.
    streaming = False
    thinking = False
    if busy:
        if _assistant_after_last_prompt(history_text or screen_visible_text):
            streaming = True
        else:
            thinking = True

    state = TurnState(
        is_ready_for_input=ready,
        is_thinking=thinking,
        is_in_modal=in_modal,
        is_streaming=streaming,
        spinner_label=spinner,
        last_changed_at=now,
    )

    if prev is not None and prev._signature() == state._signature():
        # No state-class change — preserve the original transition timestamp
        # so ``is_turn_complete`` can measure dwell time.
        state.last_changed_at = prev.last_changed_at

    return state


def is_turn_complete(
    state_history: list[TurnState],
    *,
    idle_sec: float = 1.0,
) -> bool:
    """True iff the tail of ``state_history`` shows ``is_ready_for_input=True``
    continuously for at least ``idle_sec`` seconds (measured by the
    ``last_changed_at`` of the earliest state in the contiguous ready run).

    The caller is expected to call ``detect_turn_state`` periodically (e.g.
    every 200 ms) and append the result. ``is_turn_complete`` walks the tail
    backward, looking for an uninterrupted run of ready states; if that run
    began at least ``idle_sec`` ago, the turn is done.
    """
    if not state_history:
        return False

    # Walk back over the contiguous ready-states at the tail.
    run_start: Optional[TurnState] = None
    for st in reversed(state_history):
        if st.is_ready_for_input and not st.is_thinking and not st.is_in_modal \
                and not st.is_streaming:
            run_start = st
        else:
            break

    if run_start is None:
        return False
    now = time.monotonic()
    return (now - run_start.last_changed_at) >= idle_sec


# ============================================================================
# Self-tests
# ============================================================================

def _self_tests() -> int:
    """Capture live fixtures and assert classifier output. Exit 0 on success."""
    import os
    import sys
    import select
    import tempfile
    from pathlib import Path

    import ptyprocess
    import pyte

    COLS, ROWS = 200, 60
    FIX = Path("/tmp/tui-spike/fixtures")
    FIX.mkdir(parents=True, exist_ok=True)

    def render(scr: pyte.Screen) -> str:
        return "\n".join(line.rstrip() for line in scr.display).rstrip()

    def drain(pty, scr, st, *, quiet_sec=2.0, hard=10.0):
        deadline = time.monotonic() + hard
        last = time.monotonic()
        while True:
            now = time.monotonic()
            if now > deadline or now - last > quiet_sec:
                break
            try:
                r, _, _ = select.select([pty.fd], [], [], 0.3)
                if not r:
                    continue
                chunk = pty.read(8192)
            except (EOFError, OSError):
                break
            if chunk:
                st.feed(chunk)
                last = now
        return render(scr)

    def snap(pty, scr, st, secs):
        deadline = time.monotonic() + secs
        while time.monotonic() < deadline:
            try:
                r, _, _ = select.select([pty.fd], [], [], 0.2)
                if not r:
                    continue
                chunk = pty.read(8192)
            except (EOFError, OSError):
                break
            if chunk:
                st.feed(chunk)
        return render(scr)

    scratch = Path(tempfile.mkdtemp(prefix="turncomplete-"))
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CLAUDECODE", "CLAUDE_CODE_"))}
    env.update(TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS))

    print(f"[selftest] scratch cwd: {scratch}")
    pty = ptyprocess.PtyProcessUnicode.spawn(
        ["claude"], cwd=str(scratch), env=env, dimensions=(ROWS, COLS))
    scr = pyte.Screen(COLS, ROWS)
    st = pyte.Stream(scr)

    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = ""):
        verdict = "PASS" if ok else "FAIL"
        print(f"  [{verdict}] {name}{(': ' + detail) if detail else ''}")
        results.append((name, ok, detail))

    # 1. Just-spawned
    s1 = drain(pty, scr, st, quiet_sec=2.5, hard=10.0)
    (FIX / "turn-spawn.txt").write_text(s1)
    st1 = detect_turn_state(s1, s1)
    print("\n[selftest] STATE @ spawn:", st1)
    check(
        "spawn -> ready_for_input",
        st1.is_ready_for_input and not st1.is_thinking
        and not st1.is_in_modal and not st1.is_streaming,
        repr(st1),
    )

    # 2. Mid-response: send a long prompt, snapshot at 1s
    pty.write("Count from 1 to 40 slowly, one per line, no preamble.")
    time.sleep(0.2)
    pty.write("\r")
    s2 = snap(pty, scr, st, 1.2)
    (FIX / "turn-mid.txt").write_text(s2)
    st2 = detect_turn_state(s2, s2)
    print("\n[selftest] STATE @ mid:", st2)
    check(
        "mid-response -> thinking OR streaming",
        (st2.is_thinking or st2.is_streaming) and not st2.is_ready_for_input
        and not st2.is_in_modal,
        repr(st2),
    )

    # 3. Post-response: drain, then idle
    s3 = drain(pty, scr, st, quiet_sec=4.0, hard=45.0)
    (FIX / "turn-post.txt").write_text(s3)
    st3 = detect_turn_state(s3, s3)
    print("\n[selftest] STATE @ post:", st3)
    check(
        "post-response -> ready_for_input",
        st3.is_ready_for_input and not st3.is_thinking
        and not st3.is_in_modal and not st3.is_streaming,
        repr(st3),
    )

    # 4. /help overlay -- exercises non-blocking overlay
    pty.write("/help")
    time.sleep(0.3)
    pty.write("\r")
    s4 = snap(pty, scr, st, 1.5)
    (FIX / "turn-help.txt").write_text(s4)
    st4 = detect_turn_state(s4, s4)
    print("\n[selftest] STATE @ /help:", st4)
    # /help is not a modal in the blocking sense; classify as in_modal=False
    check(
        "/help -> not in_modal",
        not st4.is_in_modal,
        repr(st4),
    )

    # dismiss help overlay if needed
    try:
        pty.write("\x1b")
        time.sleep(0.4)
    except Exception:
        pass
    drain(pty, scr, st, quiet_sec=1.0, hard=3.0)

    # 5. Permission modal: trigger a Bash tool
    pty.write("Use the bash tool to run `ls /tmp` and report.")
    time.sleep(0.2)
    pty.write("\r")
    s5 = snap(pty, scr, st, 8.0)
    (FIX / "turn-modal.txt").write_text(s5)
    st5 = detect_turn_state(s5, s5)
    print("\n[selftest] STATE @ permission modal:", st5)
    check(
        "permission prompt -> in_modal",
        st5.is_in_modal and not st5.is_ready_for_input,
        repr(st5),
    )

    # 6. is_turn_complete behavior on a synthesized history
    t0 = time.monotonic() - 5.0
    busy_state = TurnState(False, True, False, False, "Hashing", t0)
    ready_state = TurnState(True, False, False, False, None, t0 + 0.1)
    history = [busy_state, busy_state, ready_state, ready_state]
    # ready_state.last_changed_at is ~4.9s ago -> idle_sec=1.0 should be True
    check(
        "is_turn_complete after 4.9s idle, idle_sec=1.0",
        is_turn_complete(history, idle_sec=1.0),
        "expected True",
    )
    # idle_sec=10.0 should be False
    check(
        "is_turn_complete after 4.9s idle, idle_sec=10.0",
        not is_turn_complete(history, idle_sec=10.0),
        "expected False",
    )
    # Mixed history with non-ready tail
    history2 = [ready_state, ready_state, busy_state]
    check(
        "is_turn_complete with busy tail",
        not is_turn_complete(history2, idle_sec=0.1),
        "expected False",
    )
    # Empty history
    check(
        "is_turn_complete with empty history",
        not is_turn_complete([], idle_sec=0.1),
        "expected False",
    )

    # 7. detect_turn_state preserves last_changed_at when classification unchanged
    s1b = s1  # same screen content
    st1_first = detect_turn_state(s1, s1)
    time.sleep(0.05)
    st1_second = detect_turn_state(s1b, s1b, prev=st1_first)
    check(
        "last_changed_at preserved when state unchanged",
        st1_second.last_changed_at == st1_first.last_changed_at,
        f"first={st1_first.last_changed_at} second={st1_second.last_changed_at}",
    )

    # Tidy up
    try:
        pty.write("\x1b")  # close any modal
        time.sleep(0.2)
        pty.terminate(force=True)
    except Exception:
        pass

    print("\n[selftest] SUMMARY")
    n_pass = sum(1 for _, ok, _ in results if ok)
    n_fail = len(results) - n_pass
    print(f"  {n_pass} passed, {n_fail} failed")
    print(f"\n[selftest] fixtures saved under: {FIX}")
    for p in sorted(FIX.glob("turn-*.txt")):
        print(f"    {p}")

    return 0 if n_fail == 0 else 1


if __name__ == "__main__":
    import sys
    sys.exit(_self_tests())
