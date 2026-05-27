"""Regression gates for the post-failure recovery deadlock.

Live-observed 2026-05-25 18:43Z against the cluster pod
figma-designer-bot-6bf54f559b: after the bot's first auto_login failure
at cold-boot (exit-node offline), the failure path set
state.set_active_target(None, False). The main loop then sat in the
`target is None: sleep` branch. Any subsequent /lease/acquire pushed a
_SwitchSentinel onto state.job_queue, but the only consumer
(drain_jobs_for) required pm.page — and pm had been torn down. So the
sentinel sat in the queue indefinitely, submit_switch_job timed out at
60s, and the bot ratcheted backoff on a queue that was healthy except
for being unreachable. Same chicken-and-egg as BLO-6870 (cold-boot
deadlock) but triggered post-failure rather than pre-bootstrap.

Three regression gates here:

1. `drain_pending_switch_sentinels()` processes sentinels regardless of
   pm state, and defers page jobs back to the queue.

2. The main loop's failure paths (launch_error AND login-failure) do
   NOT call state.set_active_target(None, False) — they leave target
   set so the next iteration retries naturally.

3. The main loop's rebuild block has an identity_in_backoff() check
   before launching Camoufox, so it doesn't hot-loop on a known-bad
   identity.
"""

from __future__ import annotations

import ast
import queue
import threading
import time
from pathlib import Path

import pytest

from figma_bot import state
from figma_bot.identity_registry import (
    get_identity_state,
    record_login_failure,
)
from figma_bot.job_queue import (
    _SwitchSentinel,
    drain_pending_switch_sentinels,
    signal_switch_done,
    submit_switch_job,
)

MAIN_PY = Path(__file__).resolve().parents[1] / "src" / "figma_bot" / "__main__.py"


# ─── drain_pending_switch_sentinels ────────────────────────────────────


def test_drain_processes_pending_sentinel() -> None:
    """A sentinel queued before drain → set_active_target called with
    the sentinel's identity + force_refresh; processed_any=True."""
    state.set_active_target(None, False)
    # Mimic submit_switch_job's queue.put.
    sentinel = _SwitchSentinel("alice@example.com", force_refresh=False)
    state.job_queue.put((sentinel, {}, threading.Event()))

    processed = drain_pending_switch_sentinels()
    assert processed is True

    target, force_refresh = state.get_active_target()
    assert target == "alice@example.com"
    assert force_refresh is False


def test_drain_processes_force_refresh_sentinel() -> None:
    """The sentinel's force_refresh flag is propagated to set_active_target."""
    state.set_active_target(None, False)
    sentinel = _SwitchSentinel("bob@example.com", force_refresh=True)
    state.job_queue.put((sentinel, {}, threading.Event()))

    drain_pending_switch_sentinels()

    target, force_refresh = state.get_active_target()
    assert target == "bob@example.com"
    assert force_refresh is True


def test_drain_defers_page_jobs_back_to_queue() -> None:
    """Page jobs (non-sentinel queue entries) must be left in the queue
    so drain_jobs_for can run them once pm.page exists. Otherwise we'd
    silently drop work that callers are waiting on."""
    state.set_active_target(None, False)
    done_a = threading.Event()
    done_b = threading.Event()
    page_job_a = (lambda _p: "a-result", {"result": None, "error": None}, done_a)
    page_job_b = (lambda _p: "b-result", {"result": None, "error": None}, done_b)
    state.job_queue.put(page_job_a)
    state.job_queue.put(page_job_b)

    processed = drain_pending_switch_sentinels()
    assert processed is False  # no sentinels found

    # Both page jobs must still be in the queue.
    remaining = []
    while True:
        try:
            remaining.append(state.job_queue.get(block=False))
        except queue.Empty:
            break
    assert len(remaining) == 2
    # done events should not have been set (the jobs haven't run yet).
    assert not done_a.is_set()
    assert not done_b.is_set()


def test_drain_processes_sentinels_among_page_jobs() -> None:
    """Mixed queue: page job, sentinel, page job — sentinel processed,
    both page jobs deferred."""
    state.set_active_target(None, False)
    state.job_queue.put((lambda _p: 1, {}, threading.Event()))
    state.job_queue.put((_SwitchSentinel("c@example.com", False), {}, threading.Event()))
    state.job_queue.put((lambda _p: 2, {}, threading.Event()))

    processed = drain_pending_switch_sentinels()
    assert processed is True
    target, _ = state.get_active_target()
    assert target == "c@example.com"

    # Two page jobs should remain.
    remaining = 0
    while True:
        try:
            entry = state.job_queue.get(block=False)
            assert not isinstance(entry[0], _SwitchSentinel)
            remaining += 1
        except queue.Empty:
            break
    assert remaining == 2


def test_drain_on_empty_queue_is_noop() -> None:
    """No sentinels, no page jobs → processed_any=False, no error."""
    state.set_active_target(None, False)
    # queue is empty (conftest drains between tests)

    processed = drain_pending_switch_sentinels()
    assert processed is False


# ─── end-to-end: post-failure /lease/acquire returns instead of deadlocking ──


def test_submit_switch_job_after_failure_does_not_deadlock() -> None:
    """The full deadlock scenario, condensed:
    1. Bot's main loop has set target=None after a failure (pre-fix
       behavior we're testing the cure for).
    2. /lease/acquire-equivalent: submit_switch_job pushes a sentinel.
    3. Main-loop-equivalent: drain_pending_switch_sentinels picks it
       up despite pm being None / target being None.
    4. signal_switch_done is then called (simulating either success
       or failure path) and submit_switch_job returns.

    Pre-fix, step 3 didn't happen because drain_jobs_for required
    pm.page, so submit_switch_job timed out at 60s.
    """
    state.set_active_target(None, False)  # simulates post-failure state

    def fake_main_loop_with_pm_torn_down() -> None:
        """Simulates the new main-loop top: drain sentinels regardless
        of pm state, then signal switch as a failure (since pm is None,
        we can't actually log in). The point is that submit_switch_job
        gets a response instead of hanging."""
        # Give submit_switch_job a moment to queue the sentinel.
        time.sleep(0.1)
        processed = drain_pending_switch_sentinels()
        if processed:
            target, _ = state.get_active_target()
            # In the real main loop, this would happen at the end of
            # the rebuild block. For this test we just signal failure
            # to confirm submit_switch_job gets unblocked.
            signal_switch_done(
                target, switched=False,
                login_performed=False,
                error="simulated_retry_failure",
            )

    t = threading.Thread(target=fake_main_loop_with_pm_torn_down, daemon=True)
    t.start()

    start = time.time()
    with pytest.raises(Exception) as exc_info:  # SwitchJobError
        submit_switch_job("alice@example.com", False, timeout=3.0)
    elapsed = time.time() - start

    # The fix MUST get a real failure reason through within ~1s,
    # NOT switch_timeout after the full 3s window. Pre-fix this
    # took the entire timeout.
    assert "simulated_retry_failure" in str(exc_info.value)
    assert elapsed < 2.5, (
        f"submit_switch_job took {elapsed:.2f}s — the sentinel-drain "
        f"path didn't kick in. Pre-fix this would have hit the full "
        f"timeout. (Test budget: 3s; we expect ~1s.)"
    )

    t.join(timeout=1.0)


# ─── AST safety checks on __main__.py ──────────────────────────────────


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


def test_main_loop_drains_sentinels_before_target_check(
    main_func_ast: ast.FunctionDef,
) -> None:
    """Inside `while True:`, drain_pending_switch_sentinels() MUST be
    called BEFORE the `target is None` check. Otherwise the post-
    failure deadlock returns — sentinels need to be drainable even
    when pm is gone and target was cleared."""
    while_node = next(
        (
            n for n in main_func_ast.body
            if isinstance(n, ast.While)
            and isinstance(n.test, ast.Constant)
            and n.test.value is True
        ),
        None,
    )
    assert while_node is not None

    # Find the index of the drain call and the target-is-None check.
    drain_idx = None
    target_check_idx = None
    for i, stmt in enumerate(while_node.body):
        stmt_src = ast.unparse(stmt)
        if "drain_pending_switch_sentinels" in stmt_src and drain_idx is None:
            drain_idx = i
        if "target is None" in stmt_src and target_check_idx is None:
            target_check_idx = i
    assert drain_idx is not None, (
        "main() while-loop is missing the drain_pending_switch_sentinels() "
        "call. Without it, /lease/acquire deadlocks for 60s after the first "
        "auto_login failure. See test docstring."
    )
    assert target_check_idx is not None
    assert drain_idx < target_check_idx, (
        f"drain_pending_switch_sentinels() must be called BEFORE the "
        f"`target is None` check (currently at idx {drain_idx} vs {target_check_idx})"
    )


def test_failure_paths_do_not_clear_active_target(
    main_func_ast: ast.FunctionDef,
) -> None:
    """Pre-fix bug: the launch_error and login-failure paths called
    `state.set_active_target(None, False)`, which made the main loop
    deadlock at the `target is None: sleep` branch. The fix removes
    those calls so the loop keeps retrying (governed by the cooldown).

    This test verifies neither pattern is reintroduced. Note that the
    cold-boot bootstrap call `state.set_active_target(default, ...)`
    BEFORE `while True:` is fine — only inside-loop None clears are bad.
    """
    while_node = next(
        (
            n for n in main_func_ast.body
            if isinstance(n, ast.While)
            and isinstance(n.test, ast.Constant)
            and n.test.value is True
        ),
        None,
    )
    assert while_node is not None
    loop_src = ast.unparse(ast.Module(body=while_node.body, type_ignores=[]))

    # Look for set_active_target(<anything>, ...) where the first arg is
    # the literal None. Use AST walk for correctness.
    tree = ast.parse(loop_src)
    bad_calls = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        # Match `state.set_active_target(...)` or bare `set_active_target(...)`.
        is_target_call = (
            (isinstance(node.func, ast.Attribute) and node.func.attr == "set_active_target")
            or (isinstance(node.func, ast.Name) and node.func.id == "set_active_target")
        )
        if not is_target_call:
            continue
        if node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value is None:
            bad_calls.append(ast.unparse(node))

    assert not bad_calls, (
        f"main() while-loop body still contains set_active_target(None, ...) "
        f"call(s): {bad_calls}. These re-introduce the post-failure deadlock "
        f"by leaving the main loop sleeping on `target is None`. Remove them — "
        f"the backoff check + identity_in_backoff governs retry cadence instead."
    )


def test_rebuild_block_has_identity_in_backoff_check(
    main_func_ast: ast.FunctionDef,
) -> None:
    """If we removed set_active_target(None, False) but kept rebuilding
    Camoufox every iteration, the bot would hot-loop on a permafailing
    identity (launching+killing Camoufox every ~15s). The backoff
    check at the top of the rebuild block prevents that — only retry
    after the cooldown clears.
    """
    while_node = next(
        (
            n for n in main_func_ast.body
            if isinstance(n, ast.While)
            and isinstance(n.test, ast.Constant)
            and n.test.value is True
        ),
        None,
    )
    assert while_node is not None
    rebuild_if = next(
        (
            n for n in while_node.body
            if isinstance(n, ast.If) and "pm" in ast.dump(n.test)
        ),
        None,
    )
    assert rebuild_if is not None

    rebuild_src = ast.unparse(ast.Module(body=rebuild_if.body, type_ignores=[]))
    assert "identity_in_backoff" in rebuild_src, (
        "rebuild block must call identity_in_backoff(target) before "
        "launching Camoufox. Without it, a permafailing identity will "
        "hot-loop Camoufox launches every JOB_POLL_INTERVAL seconds."
    )


# ─── interaction: backoff after failure ─────────────────────────────────


def test_record_login_failure_sets_backoff_for_subsequent_in_backoff_check() -> None:
    """Sanity: after record_login_failure with transient_infra=True,
    identity_in_backoff() returns a positive value — the main loop's
    backoff check will sleep instead of immediately retrying. This is
    what gates the retry cadence after we removed the set_active_target
    (None) clear."""
    from figma_bot.identity_registry import identity_in_backoff

    ident = "backoff-check@example.com"
    s = get_identity_state(ident)
    s.consecutive_failures = 0
    s.backoff_until = None

    assert identity_in_backoff(ident) is None  # baseline: not in backoff

    record_login_failure(ident, "transient_network:flap", transient_infra=True)

    remain = identity_in_backoff(ident)
    assert remain is not None and remain > 0, (
        f"after record_login_failure(transient_infra=True), "
        f"identity_in_backoff should return a positive value; got {remain}"
    )
