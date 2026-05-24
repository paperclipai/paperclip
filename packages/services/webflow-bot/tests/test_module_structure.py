"""Structural sanity tests for the split webflow_bot package.

After the BLO-6870 modular split, the 763-line ConfigMap extract was carved
into focused modules:

    __main__.py     → main(), entry point + camoufox orchestration
    config.py       → env-derived constants
    state.py        → shared mutable globals + log + set_phase
    page_ops.py     → low-level Page helpers (run_in_page, fill_locator, …)
    endpoints.py    → ep_* + ROUTES (HTTP POST contract surface)
    login.py        → do_login + is_logged_in + park_for_manual_login
    designer.py     → is_on_designer + try_launch_bridge_app
    control_plane.py → ControlHandler + ControlServer

These tests run via AST inspection so they do NOT require Camoufox or
Playwright to be installed. They gate against:

  1. Syntax regressions in any module
  2. Critical entry points / classes / functions going missing across the
     surface that other systems (operator runbooks, cluster yaml) depend on
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1] / "src" / "webflow_bot"


def _read_ast(filename: str) -> ast.Module:
    return ast.parse((PKG / filename).read_text())


@pytest.fixture(scope="module")
def asts() -> dict[str, ast.Module]:
    """Parse every .py module in the package once per test session."""
    return {f.name: ast.parse(f.read_text()) for f in PKG.glob("*.py")}


def _top_funcs(tree: ast.Module) -> set[str]:
    return {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}


def _top_classes(tree: ast.Module) -> set[str]:
    return {n.name for n in tree.body if isinstance(n, ast.ClassDef)}


def _top_assignments(tree: ast.Module) -> set[str]:
    """Module-level constant/variable names. Returns names assigned at the
    top level so tests can check for things like ROUTES being defined."""
    out: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out.add(t.id)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            out.add(node.target.id)
    return out


# ─── Module presence ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "module_name",
    [
        "__main__.py",
        "config.py",
        "state.py",
        "page_ops.py",
        "endpoints.py",
        "login.py",
        "designer.py",
        "control_plane.py",
    ],
)
def test_module_parses_as_valid_python(asts: dict[str, ast.Module], module_name: str) -> None:
    """Every module in the split must parse cleanly."""
    assert module_name in asts, f"missing module: {module_name}"
    assert isinstance(asts[module_name], ast.Module)
    assert len(asts[module_name].body) > 0


# ─── Critical functions per module ──────────────────────────────────────


def test_main_module_has_entry_point(asts: dict[str, ast.Module]) -> None:
    """`python3 -m webflow_bot` needs a `main()` callable in __main__.py."""
    assert "main" in _top_funcs(asts["__main__.py"])


def test_config_has_credential_assertion(asts: dict[str, ast.Module]) -> None:
    """assert_credentials_present is what fails the bot fast on missing
    secrets — must stay callable from main()."""
    assert "assert_credentials_present" in _top_funcs(asts["config.py"])


def test_config_env_constants_present(asts: dict[str, ast.Module]) -> None:
    """Env-derived constants must stay at module top level."""
    consts = _top_assignments(asts["config.py"])
    for name in [
        "PROFILE_DIR",
        "SITE_URL",
        "DASHBOARD_URL",
        "REFRESH_SECONDS",
        "EMAIL",
        "PASSWORD",
        "CONTROL_PORT",
        "CONTROL_TOKEN",
        "STATE_FILE",
    ]:
        assert name in consts, f"missing env constant: {name}"


def test_state_module_surface(asts: dict[str, ast.Module]) -> None:
    funcs = _top_funcs(asts["state.py"])
    # log + set_phase are called from every module
    assert "log" in funcs
    assert "set_phase" in funcs
    # Setters for module-attribute reassignment (needed because `global`
    # doesn't cross module boundaries)
    assert "set_page" in funcs
    assert "set_context" in funcs
    assert "set_last_health_at" in funcs


def test_page_ops_helpers(asts: dict[str, ast.Module]) -> None:
    funcs = _top_funcs(asts["page_ops.py"])
    assert "run_in_page" in funcs
    assert "click_aid_by_coords" in funcs
    assert "fill_aid" in funcs
    assert "fill_locator" in funcs


@pytest.mark.parametrize(
    "ep",
    [
        "ep_screenshot",
        "ep_eval",
        "ep_key",
        "ep_click",
        "ep_dblclick",
        "ep_drag",
        "ep_selector_click",
        "ep_set_html_embed",
        "ep_create_page",
    ],
)
def test_endpoint_function_present(asts: dict[str, ast.Module], ep: str) -> None:
    """Every HTTP /endpoint handler must remain as a top-level function in
    endpoints.py so the ROUTES dict can reference it."""
    assert ep in _top_funcs(asts["endpoints.py"])


def test_routes_dict_present(asts: dict[str, ast.Module]) -> None:
    """ROUTES is the source of truth for the HTTP POST contract surface
    that cluster agents depend on. Pin its presence at module top level."""
    assert "ROUTES" in _top_assignments(asts["endpoints.py"])


def test_login_module_surface(asts: dict[str, ast.Module]) -> None:
    funcs = _top_funcs(asts["login.py"])
    assert "do_login" in funcs
    assert "is_logged_in" in funcs
    assert "on_login_required" in funcs
    assert "park_for_manual_login" in funcs
    assert "clear_manual_login" in funcs


def test_designer_module_surface(asts: dict[str, ast.Module]) -> None:
    funcs = _top_funcs(asts["designer.py"])
    assert "is_on_designer" in funcs
    assert "has_bridge_app" in funcs
    assert "open_designer" in funcs
    assert "try_launch_bridge_app" in funcs


def test_control_plane_classes_present(asts: dict[str, ast.Module]) -> None:
    classes = _top_classes(asts["control_plane.py"])
    assert "ControlHandler" in classes
    assert "ControlServer" in classes


# ─── Whole-package invariants ───────────────────────────────────────────


def test_main_has_shebang(asts: dict[str, ast.Module]) -> None:
    """The shebang lets the file be run directly during noVNC-bootstrap
    debugging without `python3 -m webflow_bot`."""
    first_line = (PKG / "__main__.py").read_text().splitlines()[0]
    assert first_line.startswith("#!"), "missing shebang line"


def test_every_module_has_docstring(asts: dict[str, ast.Module]) -> None:
    """Each split module should document its responsibility — useful when
    someone is dropped into the codebase via grep."""
    for name, tree in asts.items():
        if name == "__init__.py":
            continue
        assert ast.get_docstring(tree) is not None, f"missing docstring: {name}"
