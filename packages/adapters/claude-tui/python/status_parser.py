#!/usr/bin/env python3
"""Pure parsers for the `claude` TUI screen text (v2.1.114).

This module exposes dataclasses + pure parser functions:

    parse_welcome(snapshot_text)        -> WelcomeInfo
    parse_footer(snapshot_text)         -> FooterInfo
    parse_usage_overlay(snapshot_text)  -> UsageInfo | None
    parse_status_overlay(snapshot_text) -> StatusInfo | None

Each parser is text-in, dataclass-out. No PTY, no I/O.

`python status_parser.py capture`   -- spawn claude, dump 4 fixtures
`python status_parser.py parse`     -- load fixtures, run parsers, PASS/FAIL
`python status_parser.py all`       -- capture then parse
"""
from __future__ import annotations

import os
import re
import select
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

# Box-drawing characters that decorate the TUI. We strip / ignore these in
# patterns so the parsers don't care about pretty borders.
_BOX_CHARS = "│─╭╮╰╯├┤┬┴┼╞╡╪═║╔╗╚╝╠╣╦╩╬▌▐▛▜▟▙█▝▘"
_BOX_RE = re.compile(f"[{re.escape(_BOX_CHARS)}]")

# A loose UUID-ish pattern: hex chunks separated by dashes.
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class WelcomeInfo:
    user_display_name: str | None = None  # "Chrysler"
    model: str | None = None              # "Opus 4.7"
    plan: str | None = None               # "Claude Max"
    account: str | None = None            # email
    organization: str | None = None
    cwd: str | None = None


@dataclass
class FooterInfo:
    effort: str | None = None             # "xhigh"
    context_pct: int | None = None        # 0..100, if shown
    spinner_label: str | None = None      # "Thinking…" / "Hashing…" or None
    autoupdate_failed: bool = False


@dataclass
class UsageInfo:
    session_pct_used: int | None = None
    session_resets_at: str | None = None
    week_all_pct_used: int | None = None
    week_all_resets_at: str | None = None
    week_sonnet_pct_used: int | None = None
    week_sonnet_resets_at: str | None = None
    insights: list[str] = field(default_factory=list)


@dataclass
class StatusInfo:
    session_id: str | None = None
    working_dir: str | None = None
    model: str | None = None
    effort: str | None = None
    raw_text: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _strip_box(text: str) -> str:
    """Strip box-drawing chars and collapse whitespace runs per line."""
    out = []
    for line in text.splitlines():
        line = _BOX_RE.sub(" ", line)
        line = re.sub(r"[ \t]+", " ", line).strip()
        out.append(line)
    return "\n".join(out)


def _first(pattern: re.Pattern[str] | str, text: str, group: int = 1, flags: int = 0) -> str | None:
    if isinstance(pattern, str):
        pattern = re.compile(pattern, flags)
    m = pattern.search(text)
    if not m:
        return None
    try:
        return m.group(group).strip()
    except IndexError:
        return None


# ---------------------------------------------------------------------------
# Welcome banner
# ---------------------------------------------------------------------------

# Welcome lines look like (after box-stripping):
#   Welcome back Chrysler!
#   Opus 4.7 · Claude Max · adechrysler@gmail.com's Organization
#   /tmp/turncomplete-explore-duir4r_l
#
# But sometimes the email/org line wraps. We normalize by joining adjacent
# lines that have no leading bullet/punct.

def parse_welcome(snapshot_text: str) -> WelcomeInfo:
    text = _strip_box(snapshot_text)
    info = WelcomeInfo()

    # Display name. Tolerate "Welcome back X!" or "Welcome back, X!"
    info.user_display_name = _first(
        r"Welcome back[, ]+([^!\n]+?)!",
        text,
    )

    # Restrict our search to the banner region only -- i.e. up to (but not
    # including) the first "❯" prompt indicator OR the horizontal-rule line of
    # dashes that marks the message-input row. This keeps the footer's
    # "/effort" / autoupdate text out of the banner parse.
    banner = text
    cutoff_re = re.search(r"\n\s*(?:❯|-{20,})", text)
    if cutoff_re:
        banner = text[: cutoff_re.start()]

    # Find the "Opus 4.7 · Claude Max · …" identity line (may wrap to next line).
    # Separator is "·" (U+00B7) but tolerate "|" too.
    sep = r"\s*[·|]\s*"
    m = re.search(
        rf"([A-Za-z][\w.\- ]+?){sep}([A-Za-z][\w.\- ]+?){sep}([\s\S]+?)(?:\n\s*\n|\Z)",
        banner,
    )
    if m:
        candidate_model = m.group(1).strip()
        # Heuristic: model line should contain a digit or "Opus|Sonnet|Haiku".
        if re.search(r"\d|Opus|Sonnet|Haiku", candidate_model):
            info.model = candidate_model
            info.plan = m.group(2).strip()
            tail = re.sub(r"\s+", " ", m.group(3)).strip()
            email_m = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", tail)
            if email_m:
                info.account = email_m.group(0)
            if info.account:
                after = tail.split(info.account, 1)[1]
                # Strip leading possessive ("'s " or "\u2019s ") and stray quotes.
                after = re.sub(r"^['\u2019]?s?\s+", "", after).strip()
                # The org string in this build is literally the word "Organization"
                # OR "<Name>'s Organization". If something else followed on the
                # wrapped line, keep only up to the first run of 2+ spaces or a "/"
                # path indicator that signals we crossed into the cwd line.
                after = re.split(r"\s{2,}|(?=/[\w])", after, maxsplit=1)[0].strip()
                if after:
                    info.organization = after
            else:
                info.organization = tail or None

    # CWD: a line inside the banner that is just a path.
    cwd_m = re.search(r"(^|\n)\s*(/[\w./@\-+]+)\s*(?=\n|$)", banner)
    if cwd_m:
        info.cwd = cwd_m.group(2).strip()

    return info


# ---------------------------------------------------------------------------
# Footer
# ---------------------------------------------------------------------------

# Footer typically last 2-3 lines:
#   ✗ Auto-update failed · Try claude doctor or npm i -g @anthropic-ai/claude-code
#   ? for shortcuts                                              ◉ xhigh · /effort
#
# During a turn the left side says "esc to interrupt" and a spinner sits
# in the body area (e.g. "✻ Hashing…", "✽ Warping…").
#
# Context warnings: in some versions Claude Code shows
#   "Context left until /compact: 23%"  or  "87% context used"
# Search anywhere in screen.

_SPINNER_GLYPHS = "✻✽✶✳⚙⏳●◐◓◑◒◌◍◉◎◯"
_SPINNER_RE = re.compile(
    rf"[{re.escape(_SPINNER_GLYPHS)}]\s+([A-Z][A-Za-z]+(?:ing|ed|…)\u2026?)"
)


def parse_footer(snapshot_text: str) -> FooterInfo:
    text = _strip_box(snapshot_text)
    info = FooterInfo()

    # Auto-update failure banner
    info.autoupdate_failed = bool(re.search(r"Auto-?update failed", text, re.IGNORECASE))

    # Effort indicator: "◉ xhigh · /effort" or "● high · /effort"
    eff_m = re.search(
        r"[\u25c9\u25cf\u25cb\u25c8]?\s*([A-Za-z]+)\s*[·|]\s*/effort",
        text,
    )
    if eff_m:
        info.effort = eff_m.group(1).strip()
    else:
        # Fallback: bare "/effort" with previous word
        eff_m2 = re.search(r"(\S+)\s+/effort\b", text)
        if eff_m2:
            cand = eff_m2.group(1).strip("·|◉●◌◍ ")
            if cand and cand.lower() != "the":
                info.effort = cand

    # Context window percentage. Try several phrasings.
    ctx_patterns = [
        r"(\d{1,3})\s*%\s*context\s*used",
        r"context\s*[:\-]\s*(\d{1,3})\s*%",
        r"Context\s+left.*?(\d{1,3})\s*%",
        r"(\d{1,3})\s*%\s*until\s*/compact",
    ]
    for pat in ctx_patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            try:
                pct = int(m.group(1))
                if 0 <= pct <= 100:
                    info.context_pct = pct
                    break
            except ValueError:
                pass

    # Spinner label (active turn indicator).
    sp = _SPINNER_RE.search(text)
    if sp:
        info.spinner_label = sp.group(1).rstrip("\u2026.")  # strip trailing ellipsis
    else:
        # Looser fallback: any "…"-terminated capitalized verb on its own line
        # but only if "esc to interrupt" is also visible (means a turn is live).
        if re.search(r"esc to interrupt", text, re.IGNORECASE):
            sp2 = re.search(r"([A-Z][A-Za-z]+)\u2026", text)
            if sp2:
                info.spinner_label = sp2.group(1)

    return info


# ---------------------------------------------------------------------------
# /usage overlay
# ---------------------------------------------------------------------------

def parse_usage_overlay(snapshot_text: str) -> UsageInfo | None:
    text = _strip_box(snapshot_text)

    # Heuristic: only treat as a usage overlay if the well-known tab row +
    # the "Current session" header are both present.
    if not (
        re.search(r"\bUsage\b", text)
        and re.search(r"Current session", text, re.IGNORECASE)
    ):
        return None

    info = UsageInfo()

    # Each section reads:
    #   Current session
    #   Resets 12:19pm (UTC)                               4% used
    # We capture the "Resets …" line that follows each header, then pull
    # the trailing "N% used".

    def _section(header_re: str) -> tuple[str | None, int | None]:
        m = re.search(
            header_re + r"\s*\n\s*([^\n]+)",
            text,
            re.IGNORECASE,
        )
        if not m:
            return None, None
        body = m.group(1)
        pct_m = re.search(r"(\d{1,3})\s*%\s*used", body)
        pct = int(pct_m.group(1)) if pct_m else None
        # The "resets at" is everything up to the percent (minus "Resets " prefix)
        resets = body
        if pct_m:
            resets = body[: pct_m.start()]
        resets = re.sub(r"^\s*Resets\s+", "", resets, flags=re.IGNORECASE).strip()
        return (resets or None), pct

    info.session_resets_at, info.session_pct_used = _section(r"Current session")
    info.week_all_resets_at, info.week_all_pct_used = _section(
        r"Current week\s*\(all models\)"
    )
    info.week_sonnet_resets_at, info.week_sonnet_pct_used = _section(
        r"Current week\s*\(Sonnet only\)"
    )

    # Insights: lines that look like "NN% of your usage …"
    for line in text.splitlines():
        line = line.strip()
        if re.match(r"\d{1,3}%\s+of your usage\b", line):
            info.insights.append(line)

    return info


# ---------------------------------------------------------------------------
# /status overlay
# ---------------------------------------------------------------------------

def parse_status_overlay(snapshot_text: str) -> StatusInfo | None:
    text = _strip_box(snapshot_text)

    # Detect overlay by tab row + at least one well-known label.
    # /status (in 2.x) shows tabs "Status  Config  Usage  Stats" too, plus
    # things like "Working Directory", "Model", "Account".
    has_tabs = bool(re.search(r"\bStatus\b.*\bConfig\b.*\bUsage\b", text))
    has_label = bool(
        re.search(r"Working Directory|Session ID|Account|Model", text, re.IGNORECASE)
    )
    # The /usage overlay also has the tab row; differentiate by NOT having
    # "Current session" header (which is /usage-specific).
    looks_like_usage = bool(re.search(r"Current session", text, re.IGNORECASE))
    if not has_label and not has_tabs:
        return None
    if looks_like_usage and not has_label:
        return None

    info = StatusInfo(raw_text=text)

    # Session ID: try labeled form first, then any UUID in the overlay.
    m = re.search(r"Session(?:\s*ID)?\s*[:\-]\s*([A-Za-z0-9\-]+)", text, re.IGNORECASE)
    if m:
        cand = m.group(1).strip()
        info.session_id = cand
    else:
        u = _UUID_RE.search(text)
        if u:
            info.session_id = u.group(0)

    # Working directory
    wd = re.search(
        r"(?:Working\s*Directory|cwd|Workspace)\s*[:\-]?\s*([^\n]+)",
        text,
        re.IGNORECASE,
    )
    if wd:
        wd_val = wd.group(1).strip()
        # If line is just "Working Directory" with the path on the next line.
        if not wd_val or not wd_val.startswith("/"):
            after = text[wd.end():].lstrip()
            path_m = re.match(r"(/[\w./@\-+]+)", after)
            if path_m:
                wd_val = path_m.group(1)
        info.working_dir = wd_val or None

    # Model
    mdl = re.search(
        r"Model\s*[:\-]?\s*([A-Za-z][\w.\- ]+?)(?:\s{2,}|\n|$)",
        text,
    )
    if mdl:
        info.model = mdl.group(1).strip()

    # Effort/reasoning
    eff = re.search(
        r"(?:Effort|Reasoning)\s*[:\-]?\s*([A-Za-z]+)",
        text,
        re.IGNORECASE,
    )
    if eff:
        info.effort = eff.group(1).strip()

    return info


# ---------------------------------------------------------------------------
# Capture mode (only used by __main__; not part of the parser API)
# ---------------------------------------------------------------------------

CAPTURE_COLS, CAPTURE_ROWS = 200, 60
FIXTURES_DIR = Path("/tmp/tui-spike/fixtures")


def _render(screen) -> str:
    return "\n".join(line.rstrip() for line in screen.display).rstrip()


def _drain(pty, screen, stream, *, quiet_sec: float, hard_timeout: float) -> str:
    deadline = time.monotonic() + hard_timeout
    last_recv = time.monotonic()
    while True:
        now = time.monotonic()
        if now > deadline:
            break
        if now - last_recv > quiet_sec:
            break
        try:
            r, _, _ = select.select([pty.fd], [], [], 0.5)
            if not r:
                continue
            chunk = pty.read(4096)
        except (EOFError, OSError):
            break
        if not chunk:
            continue
        stream.feed(chunk)
        last_recv = now
    return _render(screen)


def _capture_fixtures() -> dict[str, Path]:
    import ptyprocess
    import pyte

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="status-"))
    print(f"[capture] scratch cwd: {scratch}")

    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("CLAUDECODE", "CLAUDE_CODE_"))}
    env["TERM"] = "xterm-256color"
    env["COLUMNS"] = str(CAPTURE_COLS)
    env["LINES"] = str(CAPTURE_ROWS)

    pty = ptyprocess.PtyProcessUnicode.spawn(
        ["claude"],
        cwd=str(scratch),
        env=env,
        dimensions=(CAPTURE_ROWS, CAPTURE_COLS),
    )
    screen = pyte.Screen(CAPTURE_COLS, CAPTURE_ROWS)
    stream = pyte.Stream(screen)

    out: dict[str, Path] = {}
    try:
        # 1. Welcome screen
        welcome = _drain(pty, screen, stream, quiet_sec=2.0, hard_timeout=10.0)
        out["welcome"] = FIXTURES_DIR / "status-welcome.txt"
        out["welcome"].write_text(welcome)
        print(f"[capture] saved {out['welcome']}")

        # 2. Footer after a simple prompt
        pty.write("Reply with just the word OK.")
        time.sleep(0.3)
        pty.write("\r")
        footer = _drain(pty, screen, stream, quiet_sec=4.0, hard_timeout=60.0)
        out["footer"] = FIXTURES_DIR / "status-footer.txt"
        out["footer"].write_text(footer)
        print(f"[capture] saved {out['footer']}")

        # 3. /usage overlay
        pty.write("/usage")
        time.sleep(0.4)
        pty.write("\r")
        usage = _drain(pty, screen, stream, quiet_sec=2.5, hard_timeout=15.0)
        out["usage"] = FIXTURES_DIR / "status-usage.txt"
        out["usage"].write_text(usage)
        print(f"[capture] saved {out['usage']}")
        # Esc to close
        pty.write("\x1b")
        _drain(pty, screen, stream, quiet_sec=1.5, hard_timeout=5.0)

        # 4. /status overlay
        pty.write("/status")
        time.sleep(0.4)
        pty.write("\r")
        status = _drain(pty, screen, stream, quiet_sec=2.5, hard_timeout=15.0)
        out["status"] = FIXTURES_DIR / "status-statusoverlay.txt"
        out["status"].write_text(status)
        print(f"[capture] saved {out['status']}")
        pty.write("\x1b")
        _drain(pty, screen, stream, quiet_sec=1.0, hard_timeout=4.0)
    finally:
        try:
            pty.write("/exit\r")
            time.sleep(0.5)
        except Exception:
            pass
        try:
            pty.terminate(force=True)
        except Exception:
            pass

    return out


# ---------------------------------------------------------------------------
# Parse / self-test mode
# ---------------------------------------------------------------------------

def _self_test() -> int:
    welcome_path = FIXTURES_DIR / "status-welcome.txt"
    footer_path = FIXTURES_DIR / "status-footer.txt"
    usage_path = FIXTURES_DIR / "status-usage.txt"
    status_path = FIXTURES_DIR / "status-statusoverlay.txt"

    fails: list[str] = []

    def _check(name: str, ok: bool, detail: str = "") -> None:
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}{(' -- ' + detail) if detail else ''}")
        if not ok:
            fails.append(name)

    # ---- welcome ----
    if welcome_path.exists():
        snap = welcome_path.read_text()
        wi = parse_welcome(snap)
        print(f"WelcomeInfo: {asdict(wi)}")
        _check("parse_welcome.model populated", wi.model is not None, repr(wi.model))
    else:
        _check("welcome fixture present", False, str(welcome_path))

    # ---- footer ----
    if footer_path.exists():
        snap = footer_path.read_text()
        fi = parse_footer(snap)
        print(f"FooterInfo:  {asdict(fi)}")
        _check("parse_footer.effort populated", fi.effort is not None, repr(fi.effort))
    else:
        _check("footer fixture present", False, str(footer_path))

    # ---- usage ----
    if usage_path.exists():
        snap = usage_path.read_text()
        ui = parse_usage_overlay(snap)
        print(f"UsageInfo:   {asdict(ui) if ui else None}")
        ok = (
            ui is not None
            and isinstance(ui.session_pct_used, int)
            and 0 <= ui.session_pct_used <= 100
        )
        detail = f"session_pct_used={ui.session_pct_used if ui else None!r}"
        _check("parse_usage_overlay.session_pct_used is 0..100", ok, detail)
    else:
        _check("usage fixture present", False, str(usage_path))

    # ---- status ----
    if status_path.exists():
        snap = status_path.read_text()
        si = parse_status_overlay(snap)
        if si is None:
            print("StatusInfo:  None (overlay not detected)")
            _check("parse_status_overlay returned an overlay", False)
        else:
            print(f"StatusInfo:  session_id={si.session_id!r} cwd={si.working_dir!r} "
                  f"model={si.model!r} effort={si.effort!r}")
            if si.session_id is None:
                # Document but don't fail hard -- /status may not expose it.
                print("  NOTE: /status overlay did not expose a session_id; "
                      "see raw_text in fixture for what it DOES show.")
                _check("parse_status_overlay.session_id UUID-ish", False,
                       "no session_id in overlay; see report")
            else:
                ok = bool(_UUID_RE.fullmatch(si.session_id) or len(si.session_id) >= 8)
                _check("parse_status_overlay.session_id UUID-ish",
                       ok, repr(si.session_id))
    else:
        _check("status fixture present", False, str(status_path))

    print()
    if fails:
        print(f"RESULT: FAIL ({len(fails)} failure(s))")
        return 1
    print("RESULT: PASS")
    return 0


def main(argv: list[str]) -> int:
    mode = argv[1] if len(argv) > 1 else "all"
    if mode in ("capture", "all"):
        _capture_fixtures()
    if mode in ("parse", "all"):
        return _self_test()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
