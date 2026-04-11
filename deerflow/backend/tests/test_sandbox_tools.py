"""Unit tests for sandbox tool helpers: truncation, config resolution, format, and clamp."""

from types import SimpleNamespace

from src.sandbox.tools import (
    _truncate_bash_output,
    _truncate_read_file_output,
    _truncate_ls_output,
    _get_sandbox_max_chars,
    _format_glob_results,
    _format_grep_results,
    _clamp_max_results,
)
from src.sandbox.search import GrepMatch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_long_string(length: int, char: str = "x") -> str:
    """Return a string of exactly *length* characters."""
    return char * length


def _make_grep_match(path: str = "/a.py", line_number: int = 1, line: str = "hello") -> GrepMatch:
    return GrepMatch(path=path, line_number=line_number, line=line)


# ---------------------------------------------------------------------------
# _truncate_bash_output
# ---------------------------------------------------------------------------


def test_truncate_bash_output_no_op_when_under_limit():
    short = "hello world"
    assert _truncate_bash_output(short, 1000) == short


def test_truncate_bash_output_no_op_when_disabled():
    big = _make_long_string(50_000)
    assert _truncate_bash_output(big, 0) == big


def test_truncate_bash_output_middle_truncates():
    output = _make_long_string(10_000)
    result = _truncate_bash_output(output, 500)
    assert "middle truncated" in result
    # Head and tail fragments should be present
    assert result.startswith("x")
    assert result.endswith("x")


def test_truncate_bash_output_respects_max_chars():
    output = _make_long_string(100_000)
    for limit in (200, 500, 1000, 5000):
        result = _truncate_bash_output(output, limit)
        assert len(result) <= limit, f"len={len(result)} exceeded limit={limit}"


# ---------------------------------------------------------------------------
# _truncate_read_file_output
# ---------------------------------------------------------------------------


def test_truncate_read_file_output_head_truncates():
    output = _make_long_string(10_000)
    result = _truncate_read_file_output(output, 500)
    assert "truncated" in result
    assert "start_line/end_line" in result
    # Beginning preserved
    assert result.startswith("x")


def test_truncate_read_file_output_respects_max_chars():
    output = _make_long_string(100_000)
    for limit in (200, 500, 1000, 5000):
        result = _truncate_read_file_output(output, limit)
        assert len(result) <= limit, f"len={len(result)} exceeded limit={limit}"


# ---------------------------------------------------------------------------
# _truncate_ls_output
# ---------------------------------------------------------------------------


def test_truncate_ls_output_head_truncates():
    output = _make_long_string(10_000)
    result = _truncate_ls_output(output, 500)
    assert "truncated" in result
    assert "more specific path" in result
    assert result.startswith("x")


def test_truncate_ls_output_disabled_when_zero():
    big = _make_long_string(50_000)
    assert _truncate_ls_output(big, 0) == big


# ---------------------------------------------------------------------------
# _get_sandbox_max_chars
# ---------------------------------------------------------------------------


def test_get_sandbox_max_chars_reads_from_config(monkeypatch):
    sandbox_cfg = SimpleNamespace(bash_output_max_chars=42)
    app_cfg = SimpleNamespace(sandbox=sandbox_cfg)

    # _get_sandbox_max_chars does a local import of get_app_config inside a
    # try/except, so we patch it at the module where it is imported.
    import src.config.app_config as app_config_mod

    monkeypatch.setattr(app_config_mod, "get_app_config", lambda: app_cfg)
    assert _get_sandbox_max_chars("bash_output_max_chars", 9999) == 42


def test_get_sandbox_max_chars_falls_back_to_default(monkeypatch):
    import src.config.app_config as app_config_mod

    def _boom():
        raise RuntimeError("config unavailable")

    monkeypatch.setattr(app_config_mod, "get_app_config", _boom)
    assert _get_sandbox_max_chars("bash_output_max_chars", 20000) == 20000


# ---------------------------------------------------------------------------
# _format_glob_results
# ---------------------------------------------------------------------------


def test_format_glob_results_empty():
    result = _format_glob_results("/project", [], False)
    assert "No files matched" in result
    assert "/project" in result


def test_format_glob_results_with_matches():
    matches = ["/project/a.py", "/project/b.py"]
    result = _format_glob_results("/project", matches, False)
    assert "Found 2 paths" in result
    assert "1. /project/a.py" in result
    assert "2. /project/b.py" in result


def test_format_glob_results_truncated():
    matches = ["/project/a.py"]
    result = _format_glob_results("/project", matches, True)
    assert "showing first 1" in result
    assert "Results truncated" in result


# ---------------------------------------------------------------------------
# _format_grep_results
# ---------------------------------------------------------------------------


def test_format_grep_results_empty():
    result = _format_grep_results("/project", [], False)
    assert "No matches found" in result
    assert "/project" in result


def test_format_grep_results_with_matches():
    matches = [
        _make_grep_match("/project/a.py", 10, "import os"),
        _make_grep_match("/project/b.py", 42, "import sys"),
    ]
    result = _format_grep_results("/project", matches, False)
    assert "Found 2 matches" in result
    assert "/project/a.py:10: import os" in result
    assert "/project/b.py:42: import sys" in result


def test_format_grep_results_truncated():
    matches = [_make_grep_match()]
    result = _format_grep_results("/project", matches, True)
    assert "showing first 1" in result
    assert "Results truncated" in result


# ---------------------------------------------------------------------------
# _clamp_max_results
# ---------------------------------------------------------------------------


def test_clamp_max_results_returns_default_for_zero():
    assert _clamp_max_results(0, default=200, upper_bound=1000) == 200


def test_clamp_max_results_caps_at_upper_bound():
    assert _clamp_max_results(9999, default=200, upper_bound=1000) == 1000


def test_clamp_max_results_passes_through_valid():
    assert _clamp_max_results(50, default=200, upper_bound=1000) == 50
