"""Regression gate for BLO-6870's cold-bootstrap chicken-and-egg fix.

The cluster's v0.3 figma-bot (PR #306 in onprem-k8s) shipped a deadlock:
on cold boot, the main loop checked `_active_target` (None) → slept →
continued, never reaching `_drain_jobs_for`. But `_drain_jobs_for` is the
ONLY thing that pulls `_SwitchSentinel`s off `_job_queue` and SETS
`_active_target`. So the queue filled with sentinels and the loop
slept forever.

The user-visible symptom was: every first `/lease/acquire` returned 503
`switch_timeout` after exactly 60s, with backoff escalating 60s → 300s →
1800s and Camoufox never launching.

The fix is at `__main__.py:main()`: set `_active_target` to the default
identity BEFORE the loop. The first iteration then has `target = default`
and builds the ProfileManager normally.

These tests verify the fix is present, the bootstrap runs before the loop,
and the main-loop entry guard accepts the default-identity bootstrap.
The fix is small (one if-block) but its absence is a hard production
deadlock — pin it.

This test runs via AST inspection so it doesn't need Camoufox/Playwright
installed.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

MAIN_PY = Path(__file__).resolve().parents[1] / "src" / "figma_bot" / "__main__.py"


@pytest.fixture(scope="module")
def main_source() -> str:
    return MAIN_PY.read_text()


@pytest.fixture(scope="module")
def main_func_ast(main_source: str) -> ast.FunctionDef:
    """Return the AST node for `def main():` at module top level."""
    tree = ast.parse(main_source)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "main":
            return node
    raise AssertionError("main() not found at module top level")


def _find_while_true_index(stmts: list[ast.stmt]) -> int:
    """Return the index of the `while True:` statement in main()'s body."""
    for i, node in enumerate(stmts):
        if (
            isinstance(node, ast.While)
            and isinstance(node.test, ast.Constant)
            and node.test.value is True
        ):
            return i
    raise AssertionError("`while True:` loop not found in main()")


def test_main_has_default_identity_bootstrap(main_func_ast: ast.FunctionDef) -> None:
    """Before the main-loop's `while True:`, main() MUST call
    `state.set_active_target(default, ...)` so the first iteration has a target.
    Without this call, `state.get_active_target()` returns None forever and the
    loop deadlocks on `/lease/acquire`."""
    while_idx = _find_while_true_index(main_func_ast.body)
    pre_loop_stmts = main_func_ast.body[:while_idx]
    src = ast.unparse(ast.Module(body=pre_loop_stmts, type_ignores=[]))
    assert "set_active_target(" in src, (
        "main() is missing the cold-boot bootstrap — `set_active_target(...)` "
        "must be called BEFORE `while True:` so the first loop iteration has "
        "a non-None target. See BLO-6870 PR 2."
    )


def test_bootstrap_uses_default_identity(main_func_ast: ast.FunctionDef) -> None:
    """The bootstrap must use `_identities.default_identity()` — that's
    what reads the FIGMA_DEFAULT_IDENTITY env var. Using a hard-coded
    identity would silently fail in a multi-tenant deploy."""
    while_idx = _find_while_true_index(main_func_ast.body)
    pre_loop_stmts = main_func_ast.body[:while_idx]
    src = ast.unparse(ast.Module(body=pre_loop_stmts, type_ignores=[]))
    assert "default_identity(" in src, (
        "Cold-boot bootstrap must read _identities.default_identity(), "
        "not a hard-coded identity. See BLO-6870 PR 2."
    )


def test_bootstrap_handles_no_default_identity(main_func_ast: ast.FunctionDef) -> None:
    """If `default_identity()` returns None (no identities configured),
    the bootstrap must NOT call `_set_active_target(None, …)` — that
    would clobber the empty-state semantics. Verify a guard exists."""
    while_idx = _find_while_true_index(main_func_ast.body)
    pre_loop_stmts = main_func_ast.body[:while_idx]
    src = ast.unparse(ast.Module(body=pre_loop_stmts, type_ignores=[]))
    # The fix gates the set_active_target call behind an `if default is
    # not None:` check (or equivalent truthiness test on the default).
    assert (
        "if default is not None" in src
        or "if default:" in src
    ), (
        "Cold-boot bootstrap must guard `_set_active_target(default, …)` "
        "behind a None-check; calling _set_active_target(None, False) "
        "defeats the purpose of the fix. See BLO-6870 PR 2."
    )


def test_bootstrap_logs_for_operator_visibility(main_func_ast: ast.FunctionDef) -> None:
    """The bootstrap should log a line so an operator reading
    `kubectl logs` can see WHY the bot started on a given identity. The
    line should mention 'cold' or 'bootstrap' so it's grep-able from runbook
    instructions."""
    while_idx = _find_while_true_index(main_func_ast.body)
    pre_loop_stmts = main_func_ast.body[:while_idx]
    src = ast.unparse(ast.Module(body=pre_loop_stmts, type_ignores=[])).lower()
    assert "cold" in src or "bootstrap" in src, (
        "Cold-boot bootstrap should log a recognizable line for operator "
        "kubectl-logs grep."
    )


def test_old_chickens_and_eggs_unique(main_source: str) -> None:
    """The first time the bot was extracted into VCS, the main() body
    looked like:

        while True:
            target, force_refresh = _get_active_target()
            if target is None:
                time.sleep(JOB_POLL_INTERVAL)
                continue

    …with NO bootstrap before the loop. Verify the file contains the
    bootstrap text. This is a coarse safety check on top of the AST
    tests above — if a future edit accidentally re-introduces the
    chicken-and-egg by deleting the bootstrap, this test fails with a
    clear message."""
    assert "set_active_target(default" in main_source, (
        "The cold-boot bootstrap (`state.set_active_target(default, …)` before "
        "`while True:`) appears to have been removed. This is the BLO-6870 "
        "fix — its removal would re-introduce the v0.3 chicken-and-egg "
        "production deadlock (every first /lease/acquire returns 503 "
        "switch_timeout)."
    )
