"""Regression gate for the /lease/acquire no-op switch_timeout bug.

When /lease/acquire requests the identity that pm is ALREADY on (with
`force_refresh=False`), the previous main-loop body did:

    if pm is None or pm.identity != target or force_refresh:
        # ... rebuild + signal_switch_done ...
    # else: nothing — fall through to drain_jobs_for

The _SwitchSentinel was consumed by drain_jobs_for (which set
active_target), but signal_switch_done was never called for the no-op
case. submit_switch_job waited the full 60s timeout, raised
SwitchJobError("switch_timeout"), and the control_plane recorded a
login_failure that escalated the 60s→6h backoff schedule on a healthy
bot.

The fix is at __main__.py:main()'s `while True:` body: add an `else:`
branch after the `if pm is None or ...:` block that calls
signal_switch_done(target, switched=False, login_performed=False,
error=None). signal_switch_done is idempotent — it's a no-op if no
pending entry matches — so calling it every iteration is safe.

Live-observed 2026-05-25 06:31 against the cluster pod
figma-designer-bot-676d5ffbcd-fcnf8: two consecutive
/lease/acquire{client_id:omar-sanity-test, force_refresh:false} calls
each timed out at 60s and ratcheted the backoff from 60s → 300s →
1800s with the bot already on the requested identity and Camoufox
serving figma.com/files/team/.../recents-and-sharing fine.
"""

from __future__ import annotations

import ast
import threading
import time
from pathlib import Path

import pytest

from figma_bot import state
from figma_bot.job_queue import (
    SwitchJobError,
    _SwitchSentinel,
    signal_switch_done,
    submit_switch_job,
)

MAIN_PY = Path(__file__).resolve().parents[1] / "src" / "figma_bot" / "__main__.py"


# ─── AST safety check ──────────────────────────────────────────────────


@pytest.fixture(scope="module")
def main_source() -> str:
    return MAIN_PY.read_text()


@pytest.fixture(scope="module")
def main_func_ast(main_source: str) -> ast.FunctionDef:
    tree = ast.parse(main_source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "main":
            return node
    raise AssertionError("main() not found at module top level")


def test_main_loop_has_noop_signal_branch(main_func_ast: ast.FunctionDef) -> None:
    """Inside `while True:`, the `if pm is None or pm.identity != target or
    force_refresh:` block MUST have an `else:` branch that calls
    signal_switch_done. Without it, the no-op switch case deadlocks
    submit_switch_job for 60s and ratchets backoff on a healthy bot."""
    # Walk the main()'s body looking for the while-true loop.
    while_node = next(
        (
            n for n in main_func_ast.body
            if isinstance(n, ast.While)
            and isinstance(n.test, ast.Constant)
            and n.test.value is True
        ),
        None,
    )
    assert while_node is not None, "main() is missing `while True:`"

    # Walk while body looking for the rebuild-if with an else.
    rebuild_if = next(
        (
            n for n in while_node.body
            if isinstance(n, ast.If)
            and "pm" in ast.dump(n.test)
        ),
        None,
    )
    assert rebuild_if is not None, (
        "main()'s `while True:` is missing the rebuild-if (`if pm is None or "
        "pm.identity != target or force_refresh:`)"
    )

    assert rebuild_if.orelse, (
        "main()'s rebuild-if block needs an `else:` branch that calls "
        "signal_switch_done for the no-op switch case (target == pm.identity, "
        "force_refresh=False). Without it, /lease/acquire deadlocks for 60s "
        "and ratchets backoff. See test docstring."
    )

    else_src = ast.unparse(ast.Module(body=rebuild_if.orelse, type_ignores=[]))
    assert "signal_switch_done(" in else_src, (
        "main()'s rebuild-if else branch must call signal_switch_done — that's "
        "the actual fix, not just any code in the else. The submit_switch_job "
        "caller waits on a threading.Event that only signal_switch_done sets."
    )


# ─── Functional test using the real queue + signal primitives ──────────


def test_submit_switch_job_returns_on_noop_signal_within_timeout() -> None:
    """End-to-end queue mechanics: when something simulates the main
    loop's no-op signal (consume sentinel + signal_switch_done with
    switched=False, login_performed=False), submit_switch_job must
    return immediately without hitting the 60s timeout."""
    state.set_active_target(None, False)

    def fake_main_loop_noop() -> None:
        """Pull one sentinel off the queue and signal it as no-op,
        mimicking what the production main loop does in the new
        else branch when target == pm.identity and not force_refresh."""
        try:
            fn, _box, _done = state.job_queue.get(timeout=3.0)
        except Exception:
            return
        if isinstance(fn, _SwitchSentinel):
            state.set_active_target(fn.identity, fn.force_refresh)
            # This is the line under test — it's what the new else branch
            # in main() does.
            signal_switch_done(
                fn.identity, switched=False,
                login_performed=False, error=None,
            )

    t = threading.Thread(target=fake_main_loop_noop, daemon=True)
    t.start()

    # 5s budget is generous — the signal happens within ms after the
    # sentinel is consumed. We're testing it doesn't take 60s (the
    # symptom of the bug).
    start = time.time()
    switched, login_performed = submit_switch_job("alice@example.com", False, timeout=5.0)
    elapsed = time.time() - start

    assert switched is False
    assert login_performed is False
    assert elapsed < 4.0, (
        f"submit_switch_job took {elapsed:.2f}s for a no-op — the no-op "
        f"signal path is broken. Expected sub-second return."
    )

    t.join(timeout=1.0)


def test_submit_switch_job_without_noop_signal_still_times_out() -> None:
    """Inverse: confirm that WITHOUT the signal, submit_switch_job does
    time out — proves the test infrastructure is real, and the timeout
    is what production used to hit."""
    state.set_active_target(None, False)

    def fake_main_loop_broken() -> None:
        """Mimic the BROKEN main loop: consume the sentinel but never
        signal. This is what production did before the fix."""
        try:
            fn, _box, _done = state.job_queue.get(timeout=3.0)
        except Exception:
            return
        if isinstance(fn, _SwitchSentinel):
            state.set_active_target(fn.identity, fn.force_refresh)
            # No signal_switch_done call — this is the bug.

    t = threading.Thread(target=fake_main_loop_broken, daemon=True)
    t.start()

    # 2s timeout (way shorter than the production 60s) — we don't need
    # to wait the full deadlock to prove the signal is required.
    with pytest.raises(SwitchJobError) as exc_info:
        submit_switch_job("bob@example.com", False, timeout=2.0)
    assert exc_info.value.reason == "switch_timeout"

    t.join(timeout=1.0)
