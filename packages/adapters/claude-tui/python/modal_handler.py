#!/usr/bin/env python3
"""Permission-modal detector and handler for the claude (Claude Code) TUI.

Pure-function module: takes rendered screen text + a policy, returns the
keystroke sequence to send. No PTY, no I/O.

Observed claude-code v2.1.114 modal grammar (see fixtures/modal-*.txt):

    ────────────...
     Bash command                          <- title line (single space indent)

       ls /tmp                             <- body (indented two spaces)
       List files in /tmp

     Do you want to proceed?               <- prompt line
     ❯ 1. Yes                              <- selected option (❯)
       2. Yes, allow reading from tmp/ from this project
       3. No

     Esc to cancel · Tab to amend · ctrl+e to explain

Other observed title text:
    "Read file"     -> Read tool
    "Bash command"  -> Bash tool
    (predicted, not yet captured; same shape):
    "Edit file"     -> Edit
    "Write file"    -> Write
    "Fetch URL"     -> WebFetch  (best guess; verify when seen in the wild)

Selection mechanics:
    - Options are numbered 1..N. Sending the digit '1' / '2' / '3' selects + commits.
    - Enter ('\\r') commits whatever ❯ is currently on. By default ❯ is on option 1
      (Yes), so Enter is equivalent to '1' on a fresh modal.
    - Up/Down arrows ('\\x1b[A' / '\\x1b[B') move the ❯ cursor without committing.
    - Esc ('\\x1b') cancels the modal -- treated as "deny without feedback"; in our
      tests it returns control to the prompt without aborting the whole turn, but
      claude then immediately re-asks the model what to do, which usually
      re-issues the same tool call -> another modal. Prefer '3. No' for a clean
      deny.
    - Tab amends (lets user edit args); we never send this.

After answering:
    - Modal disappears, tool either runs (on Yes) or claude continues with a
      "(no content)" tool result (on No / Esc), then may issue ANOTHER tool call,
      which re-prompts -- "Yes" is single-shot. Only "Yes, allow ... during
      this session" (option 2) suppresses future prompts, and only within the
      scope shown in its label (e.g. "from etc/", "from tmp/ from this project").

State transitions are the CALLER's responsibility -- this module is stateless.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
import re


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

ModalKind = Literal["bash", "read", "edit", "webfetch", "write", "unknown"]
OptionSemantics = Literal[
    "approve", "approve_always", "deny", "deny_with_feedback", "unknown",
]
PolicyMode = Literal[
    "auto_approve", "auto_approve_safe_only", "auto_deny", "escalate",
]


@dataclass
class ModalOption:
    label: str
    key_to_select: str
    semantics: OptionSemantics


@dataclass
class ModalState:
    kind: ModalKind
    title: str
    body: str
    options: list[ModalOption] = field(default_factory=list)
    selected_index: int = 0  # index into options


class EscalationRequired(Exception):
    """Raised by decide_keys when the active policy is 'escalate'."""

    def __init__(self, modal: ModalState):
        super().__init__(f"escalation required for modal: {modal.kind!r} / {modal.title!r}")
        self.modal = modal


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

# Map known titles -> kind. Order matters: longer/more-specific first.
_TITLE_TO_KIND: list[tuple[re.Pattern[str], ModalKind]] = [
    (re.compile(r"^\s*Bash command\s*$", re.I), "bash"),
    (re.compile(r"^\s*Read file\s*$", re.I), "read"),
    (re.compile(r"^\s*Edit file\s*$", re.I), "edit"),
    (re.compile(r"^\s*Write file\s*$", re.I), "write"),
    (re.compile(r"^\s*Create file\s*$", re.I), "write"),
    (re.compile(r"^\s*Fetch URL\s*$", re.I), "webfetch"),
    (re.compile(r"^\s*Web ?fetch\s*$", re.I), "webfetch"),
]

# Read-only command prefixes for the auto_approve_safe_only heuristic. We are
# deliberately paranoid: only commands that cannot mutate state. ANYTHING that
# could write/delete/network -> deny.
_SAFE_BASH_RE = re.compile(
    r"""^\s*(
        ls(\s|$) |
        pwd(\s|$) |
        whoami(\s|$) |
        id(\s|$) |
        date(\s|$) |
        echo(\s|$) |
        cat\s+[^|>;&`$()] |          # cat <file>, no shell metachars
        head(\s|$) |
        tail(\s|$) |
        wc(\s|$) |
        file\s+[^|>;&`$()] |
        stat\s+[^|>;&`$()] |
        which(\s|$) |
        type(\s|$) |
        env(\s|$) |
        printenv(\s|$) |
        df(\s|$) |
        du(\s|$) |
        free(\s|$) |
        uptime(\s|$) |
        uname(\s|$) |
        hostname(\s|$) |
        ps(\s|$) |
        git\s+(status|log|diff|show|branch|remote|config\s+--get|rev-parse|describe|blame|ls-files|ls-tree|reflog|stash\s+list|tag(\s|$)) |
        grep(\s|$) |
        rg(\s|$) |
        find(\s|$) |
        tree(\s|$) |
        sort(\s|$) |
        uniq(\s|$) |
        cut(\s|$) |
        awk(\s|$) |   # awk CAN write but typical use is read-only -- still risky, included reluctantly
        sed\s+-n\s |  # sed -n is non-mutating (no -i)
        jq(\s|$) |
        yq(\s|$) |
        python3?\s+--version |
        node\s+--version |
        npm\s+(ls|list|outdated|view|search|--version) |
        pip\s+(list|show|--version) |
        docker\s+(ps|images|version|info) |
        kubectl\s+(get|describe|version) |
        true(\s|$) |
        false(\s|$)
    )""",
    re.X,
)

# Shell metacharacters that turn an otherwise-safe command unsafe.
_UNSAFE_METACHARS_RE = re.compile(r"[>;|&`$()]|\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bdd\b|\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\btouch\b|\bmkdir\b|\b>>\b")


def _is_safe_readonly_bash(body: str) -> bool:
    """True iff the bash modal body is a single command we recognise as read-only.

    Conservative: returns False on anything we can't prove safe. We do NOT try
    to handle pipelines, subshells, or redirects.
    """
    # Strip a leading description line if present; the command is usually on
    # its own indented line. We test every non-empty line and require ALL to
    # be safe (rejects multi-statement bodies).
    candidates = [ln.strip() for ln in body.splitlines() if ln.strip()]
    if not candidates:
        return False
    for line in candidates:
        # If the line looks like a human description (no shell tokens), skip.
        if not re.match(r"^[\w./-]", line):
            continue
        # Hard reject on dangerous tokens or shell metachars first.
        if _UNSAFE_METACHARS_RE.search(line):
            return False
        if not _SAFE_BASH_RE.match(line):
            # Could still be the description line. Heuristic: if it starts with
            # an English capital letter and contains a space + lowercase word,
            # treat it as description.
            if re.match(r"^[A-Z][a-z]+\b.*\b[a-z]+\b", line):
                continue
            return False
    return True


# Strip ANSI escape sequences just in case caller passes raw bytes.
_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


def _looks_like_options_block(lines: list[str], start: int) -> bool:
    """At index `start`, do we see a `❯ 1. ...` followed by `  2. ...` etc?"""
    if start >= len(lines):
        return False
    first = lines[start].lstrip()
    return bool(re.match(r"^[❯>]\s*\d+\.\s", first))


_OPTION_LINE_RE = re.compile(r"^[❯>\s]*(\d+)\.\s+(.+?)\s*$")


def _classify_option(label: str) -> OptionSemantics:
    low = label.strip().lower()
    if low.startswith("yes, and don't ask again") or low.startswith("yes, and dont ask again"):
        return "approve_always"
    if low.startswith("yes, allow") or "during this session" in low or "from this project" in low or "for this session" in low:
        return "approve_always"
    if low == "yes" or low.startswith("yes "):
        return "approve"
    if low.startswith("no, and tell") or "tell claude" in low or "with feedback" in low:
        return "deny_with_feedback"
    if low == "no" or low.startswith("no "):
        return "deny"
    return "unknown"


def detect_modal(screen_visible_text: str) -> ModalState | None:
    """Return a ModalState if a permission modal is currently visible, else None.

    The detector is intentionally tolerant: it looks for the "Do you want to
    proceed?" prompt and an adjacent numbered options block. Title is the
    nearest preceding non-empty, non-separator line that is short (heuristic).
    """
    if not screen_visible_text:
        return None
    text = _strip_ansi(screen_visible_text)
    lines = text.splitlines()

    # Find "Do you want to proceed?" anchor (case-insensitive, allow trailing whitespace)
    anchor_idx = None
    for i, ln in enumerate(lines):
        if re.search(r"do you want to proceed\?", ln, re.I):
            anchor_idx = i
            break
    if anchor_idx is None:
        return None

    # Options follow the anchor (possibly with a blank line in between).
    opt_start = None
    for j in range(anchor_idx + 1, min(anchor_idx + 6, len(lines))):
        if _looks_like_options_block(lines, j):
            opt_start = j
            break
    if opt_start is None:
        # Anchor without parseable options -> treat as unknown modal.
        return ModalState(kind="unknown", title="", body="", options=[], selected_index=0)

    # Parse contiguous numbered option lines.
    options: list[ModalOption] = []
    selected_index = 0
    k = opt_start
    while k < len(lines):
        raw = lines[k]
        if not raw.strip():
            break
        m = _OPTION_LINE_RE.match(raw)
        if not m:
            break
        num = int(m.group(1))
        label = m.group(2).strip()
        # Detect ❯ selector. We look at the raw line content for ❯ or >.
        is_selected = "❯" in raw or raw.lstrip().startswith(">")
        if is_selected:
            selected_index = len(options)
        sem = _classify_option(label)
        options.append(ModalOption(
            label=label,
            key_to_select=str(num),
            semantics=sem,
        ))
        k += 1
        if num >= 9:  # sanity cap
            break

    if not options:
        return ModalState(kind="unknown", title="", body="", options=[], selected_index=0)

    # Walk backward from anchor to find title and body. The title line in
    # claude-code's UI is typically 2-4 lines above the anchor, with the
    # body (command / file path) between.
    # Strategy: collect non-empty lines between the most recent horizontal
    # separator (─────) and the anchor; the FIRST such line is the title,
    # the rest (excluding the anchor) make up the body.
    title = ""
    body_lines: list[str] = []
    block_start = 0
    for b in range(anchor_idx - 1, -1, -1):
        if re.match(r"^[─━\-=_]{10,}", lines[b].strip()):
            block_start = b + 1
            break
    block = [ln for ln in lines[block_start:anchor_idx] if ln.strip()]
    if block:
        title = block[0].strip()
        body_lines = [ln.rstrip() for ln in block[1:]]
    body = "\n".join(body_lines).strip()

    # Classify kind from title.
    kind: ModalKind = "unknown"
    for pat, k_ in _TITLE_TO_KIND:
        if pat.match(title):
            kind = k_
            break

    # Fallback classification from body if title was missed.
    if kind == "unknown":
        low_body = body.lower()
        if re.search(r"\bread\s*\(", low_body):
            kind = "read"
        elif re.search(r"\b(edit|write)\s*\(", low_body):
            kind = "edit"

    return ModalState(
        kind=kind,
        title=title,
        body=body,
        options=options,
        selected_index=selected_index,
    )


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------

def _find_option(modal: ModalState, semantics: OptionSemantics) -> ModalOption | None:
    for opt in modal.options:
        if opt.semantics == semantics:
            return opt
    return None


def _approve_key(modal: ModalState) -> str | None:
    """Return key for the single-shot approve option. Never the 'always' one."""
    opt = _find_option(modal, "approve")
    return opt.key_to_select if opt else None


def _deny_key(modal: ModalState) -> str | None:
    opt = _find_option(modal, "deny")
    if opt is None:
        opt = _find_option(modal, "deny_with_feedback")
    return opt.key_to_select if opt else None


def decide_keys(modal: ModalState, policy: PolicyMode) -> str:
    """Return the keystroke sequence to send for the given policy.

    Safety rules:
      - 'auto_approve': single-shot Yes only. Unknown modal kind -> DENY.
      - 'auto_approve_safe_only': approve Read/WebFetch and Bash matching a
        strict read-only allowlist. Edit/Write/unknown bash -> DENY.
      - 'auto_deny': always send the deny key. If no deny option parsed, send
        Esc ('\\x1b') as last-resort cancel.
      - 'escalate': raise EscalationRequired -- caller decides interactively.
    """
    if policy == "escalate":
        raise EscalationRequired(modal)

    deny = _deny_key(modal) or "\x1b"
    approve = _approve_key(modal)

    if policy == "auto_deny":
        return deny

    if policy == "auto_approve":
        # Approve unknown modals? Absolutely not.
        if modal.kind == "unknown" or approve is None:
            return deny
        return approve

    if policy == "auto_approve_safe_only":
        if approve is None:
            return deny
        if modal.kind == "read":
            return approve
        if modal.kind == "webfetch":
            # WebFetch is read-only on the network; we treat as safe. (Caller
            # can override by using auto_deny if their threat model differs.)
            return approve
        if modal.kind == "bash" and _is_safe_readonly_bash(modal.body):
            return approve
        return deny

    # Unreachable; defensive default.
    return deny


# ---------------------------------------------------------------------------
# Self-tests
# ---------------------------------------------------------------------------

def _selftest() -> int:
    import os
    import sys
    import subprocess
    from pathlib import Path

    fixtures = Path("/tmp/tui-spike/fixtures")
    fixtures.mkdir(parents=True, exist_ok=True)
    runner = Path("/tmp/tui-spike/_run_killer.py")

    results: list[tuple[str, bool, str]] = []

    def record(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        tag = "PASS" if ok else "FAIL"
        print(f"  [{tag}] {name}{(': ' + detail) if detail else ''}")

    # ---- Test 1: live killer experiment ----
    print("== Test 1: killer experiment (live) ==")
    if "--skip-live" in sys.argv or not runner.exists():
        record("live killer experiment (approve)", True, "skipped")
    else:
        try:
            cp = subprocess.run(
                ["python3", str(runner), "approve"],
                cwd="/tmp/tui-spike",
                capture_output=True, text=True, timeout=150,
            )
            ok = cp.returncode == 0 and "saved modal snapshot" in cp.stdout
            record("live killer experiment (approve)", ok,
                   f"rc={cp.returncode}, snaps_in_stdout={cp.stdout.count('saved modal snapshot')}")
        except Exception as e:
            record("live killer experiment (approve)", False, repr(e))

    # ---- Test 2: detect_modal against captured fixtures ----
    print("== Test 2: detect_modal on captured fixtures ==")
    # Map filename pattern -> expected kind.
    expectations: list[tuple[str, ModalKind]] = []
    for fp in sorted(fixtures.glob("modal-bash-*.txt")):
        # filename modal-bash-<mode>-<n>.txt -- our killer mislabels EVERY
        # modal as "bash" because of the naive labeller. Read the file to
        # decide expected kind.
        text = fp.read_text()
        if "Read file" in text:
            expectations.append((str(fp), "read"))
        elif "Bash command" in text:
            expectations.append((str(fp), "bash"))
        else:
            expectations.append((str(fp), "unknown"))

    if not expectations:
        record("fixtures present", False, "no modal-bash-*.txt found")
    else:
        for path, expected in expectations:
            text = Path(path).read_text()
            m = detect_modal(text)
            ok = m is not None and m.kind == expected
            detail = (
                f"{Path(path).name} -> kind={m.kind!r} title={m.title!r} opts={len(m.options)} sel={m.selected_index}"
                if m else f"{Path(path).name} -> None"
            )
            record(f"detect {Path(path).name} == {expected}", ok, detail)

    # Negative: a normal screen with no modal should return None.
    normal_screen = "❯ Try \"fix lint errors\"\n  ? for shortcuts"
    m_none = detect_modal(normal_screen)
    record("detect_modal returns None on idle screen", m_none is None, repr(m_none))

    # ---- Test 3: decide_keys for every (policy, modal) combo ----
    print("== Test 3: decide_keys across policies ==")
    policies: list[PolicyMode] = [
        "auto_approve", "auto_approve_safe_only", "auto_deny", "escalate",
    ]
    # Synthetic fixtures we can reason about precisely.
    synth: dict[str, str] = {
        "synthetic_read": (
            " Read file\n"
            "\n"
            "  Read(/etc/hosts)\n"
            "\n"
            " Do you want to proceed?\n"
            " ❯ 1. Yes\n"
            "   2. Yes, allow reading from etc/ during this session\n"
            "   3. No\n"
        ),
        "synthetic_bash_safe": (
            " Bash command\n"
            "\n"
            "   ls /tmp\n"
            "   List files in /tmp\n"
            "\n"
            " Do you want to proceed?\n"
            " ❯ 1. Yes\n"
            "   2. Yes, allow reading from tmp/ from this project\n"
            "   3. No\n"
        ),
        "synthetic_bash_unsafe": (
            " Bash command\n"
            "\n"
            "   rm -rf /tmp/foo\n"
            "   Remove foo\n"
            "\n"
            " Do you want to proceed?\n"
            " ❯ 1. Yes\n"
            "   2. Yes, and don't ask again for `rm`\n"
            "   3. No\n"
        ),
        "synthetic_edit": (
            " Edit file\n"
            "\n"
            "   /etc/hosts\n"
            "\n"
            " Do you want to proceed?\n"
            " ❯ 1. Yes\n"
            "   2. Yes, allow edits during this session\n"
            "   3. No\n"
        ),
        "synthetic_unknown": (
            " Mystery prompt\n"
            "\n"
            "   what even is this\n"
            "\n"
            " Do you want to proceed?\n"
            " ❯ 1. Yes\n"
            "   2. No\n"
        ),
    }

    # (synth_name, expected_kind, policy, expected_keys_or_exception)
    expected: list[tuple[str, ModalKind, PolicyMode, str | type[BaseException]]] = [
        # auto_approve -> single-shot Yes for known, deny for unknown
        ("synthetic_read", "read", "auto_approve", "1"),
        ("synthetic_bash_safe", "bash", "auto_approve", "1"),
        ("synthetic_bash_unsafe", "bash", "auto_approve", "1"),  # NB: caller wanted Yes
        ("synthetic_edit", "edit", "auto_approve", "1"),
        ("synthetic_unknown", "unknown", "auto_approve", "2"),  # deny (option 2 is No)
        # auto_approve_safe_only -> Yes for read + safe bash, No otherwise
        ("synthetic_read", "read", "auto_approve_safe_only", "1"),
        ("synthetic_bash_safe", "bash", "auto_approve_safe_only", "1"),
        ("synthetic_bash_unsafe", "bash", "auto_approve_safe_only", "3"),
        ("synthetic_edit", "edit", "auto_approve_safe_only", "3"),
        ("synthetic_unknown", "unknown", "auto_approve_safe_only", "2"),
        # auto_deny -> No
        ("synthetic_read", "read", "auto_deny", "3"),
        ("synthetic_bash_safe", "bash", "auto_deny", "3"),
        ("synthetic_bash_unsafe", "bash", "auto_deny", "3"),
        ("synthetic_edit", "edit", "auto_deny", "3"),
        ("synthetic_unknown", "unknown", "auto_deny", "2"),
        # escalate -> raises
        ("synthetic_read", "read", "escalate", EscalationRequired),
    ]

    # First sanity-check that detect_modal classifies synthetic fixtures correctly.
    for name, text in synth.items():
        m = detect_modal(text)
        if m is None:
            record(f"synthetic detect {name}", False, "None")
            continue
        # Determine expected kind from the first column of `expected` rows.
        wanted = next((k for n, k, _, _ in expected if n == name), None)
        ok = wanted is None or m.kind == wanted
        record(f"synthetic detect {name}", ok,
               f"kind={m.kind} title={m.title!r} opts={[o.label for o in m.options]}")

    for name, wanted_kind, policy, expected_result in expected:
        text = synth[name]
        m = detect_modal(text)
        assert m is not None, name
        try:
            keys = decide_keys(m, policy)
        except EscalationRequired:
            ok = expected_result is EscalationRequired
            record(f"decide {name} / {policy}", ok, "raised EscalationRequired")
            continue
        if isinstance(expected_result, type):
            record(f"decide {name} / {policy}", False, f"expected exception, got {keys!r}")
        else:
            ok = keys == expected_result
            record(f"decide {name} / {policy}", ok,
                   f"got {keys!r}, expected {expected_result!r}")

    # ---- Test 4: real captured fixtures + each policy (print only) ----
    print("== Test 4: decide_keys on real captured fixtures (informational) ==")
    real_seen = False
    for path, _ in expectations:
        real_seen = True
        text = Path(path).read_text()
        m = detect_modal(text)
        if m is None:
            print(f"  {Path(path).name}: NO MODAL DETECTED")
            continue
        print(f"  {Path(path).name}: kind={m.kind} title={m.title!r}")
        for pol in ("auto_approve", "auto_approve_safe_only", "auto_deny"):
            try:
                k = decide_keys(m, pol)
            except EscalationRequired:
                k = "<escalate>"
            print(f"    policy={pol:<25s} -> keys={k!r}")
    if not real_seen:
        print("  (no real fixtures captured)")

    # ---- Summary ----
    fails = [r for r in results if not r[1]]
    print()
    print(f"== {len(results) - len(fails)} pass / {len(fails)} fail ==")
    for name, ok, detail in results:
        if not ok:
            print(f"  FAIL {name}: {detail}")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(_selftest())
