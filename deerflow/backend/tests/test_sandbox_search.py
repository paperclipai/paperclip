"""Tests for sandbox file search utilities (glob and grep)."""

from pathlib import Path

from src.sandbox.search import find_glob_matches, find_grep_matches, GrepMatch, is_binary_file


def _make_file(base: Path, rel_path: str, content: str = "") -> Path:
    """Create a file under *base* with the given relative path and content."""
    full = base / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content)
    return full


# -- find_glob_matches ----------------------------------------------------------


def test_find_glob_matches_finds_python_files(tmp_path):
    """Glob **/*.py returns .py files scattered across subdirectories."""
    _make_file(tmp_path, "a.py", "# a")
    _make_file(tmp_path, "sub/b.py", "# b")
    _make_file(tmp_path, "sub/c.txt", "nope")

    matches, truncated = find_glob_matches(tmp_path, "**/*.py")

    basenames = sorted(Path(m).name for m in matches)
    assert basenames == ["a.py", "b.py"]
    assert truncated is False


def test_find_glob_matches_respects_max_results(tmp_path):
    """When more files match than max_results, truncated flag is True."""
    for i in range(10):
        _make_file(tmp_path, f"file_{i}.py", "# content")

    matches, truncated = find_glob_matches(tmp_path, "**/*.py", max_results=3)

    assert len(matches) == 3
    assert truncated is True


def test_find_glob_matches_excludes_dirs_by_default(tmp_path):
    """Directories are excluded from results unless include_dirs=True."""
    (tmp_path / "pkg").mkdir()
    _make_file(tmp_path, "pkg/mod.py", "# mod")

    matches_no_dirs, _ = find_glob_matches(tmp_path, "**/*")
    paths_no_dirs = [Path(m) for m in matches_no_dirs]
    assert all(p.is_file() for p in paths_no_dirs)

    matches_with_dirs, _ = find_glob_matches(tmp_path, "**/*", include_dirs=True)
    names = [Path(m).name for m in matches_with_dirs]
    assert "pkg" in names


def test_find_glob_matches_empty_dir(tmp_path):
    """An empty directory yields an empty list and truncated=False."""
    matches, truncated = find_glob_matches(tmp_path, "**/*.py")

    assert matches == []
    assert truncated is False


# -- find_grep_matches ----------------------------------------------------------


def test_find_grep_matches_finds_pattern(tmp_path):
    """Grep returns matching lines with correct paths and line numbers."""
    _make_file(tmp_path, "hello.txt", "hello world\ngoodbye world\n")

    matches, truncated = find_grep_matches(tmp_path, "hello")

    assert len(matches) == 1
    assert matches[0].line_number == 1
    assert "hello" in matches[0].line
    assert truncated is False


def test_find_grep_matches_case_insensitive(tmp_path):
    """Default search is case-insensitive."""
    _make_file(tmp_path, "mixed.txt", "Hello\nHELLO\nhello\n")

    matches, _ = find_grep_matches(tmp_path, "hello")

    assert len(matches) == 3


def test_find_grep_matches_case_sensitive(tmp_path):
    """With case_sensitive=True, only exact case matches are returned."""
    _make_file(tmp_path, "mixed.txt", "Hello\nHELLO\nhello\n")

    matches, _ = find_grep_matches(tmp_path, "hello", case_sensitive=True)

    assert len(matches) == 1
    assert matches[0].line == "hello"


def test_find_grep_matches_literal_mode(tmp_path):
    """In literal mode, regex special characters are treated as plain text."""
    _make_file(tmp_path, "regex.txt", "price is $10.00\nprice is s10s00\n")

    matches, _ = find_grep_matches(tmp_path, "$10.00", literal=True)

    assert len(matches) == 1
    assert "$10.00" in matches[0].line


def test_find_grep_matches_respects_max_results(tmp_path):
    """Truncation triggers when matches exceed max_results."""
    lines = "\n".join(f"match line {i}" for i in range(20))
    _make_file(tmp_path, "many.txt", lines + "\n")

    matches, truncated = find_grep_matches(tmp_path, "match", max_results=5)

    assert len(matches) == 5
    assert truncated is True


def test_find_grep_matches_with_glob_filter(tmp_path):
    """glob_pattern restricts which files are searched."""
    _make_file(tmp_path, "code.py", "target_value = 42\n")
    _make_file(tmp_path, "notes.txt", "target_value = 42\n")

    matches, _ = find_grep_matches(tmp_path, "target_value", glob_pattern="**/*.py")

    assert len(matches) == 1
    assert matches[0].path.endswith(".py")


# -- is_binary_file -------------------------------------------------------------


def test_is_binary_file_detects_binary(tmp_path):
    """A file containing a null byte is detected as binary."""
    p = tmp_path / "blob.bin"
    p.write_bytes(b"\x00\x01\x02\xff")

    assert is_binary_file(p) is True


def test_is_binary_file_detects_text(tmp_path):
    """A regular text file is not detected as binary."""
    p = tmp_path / "readme.md"
    p.write_text("Just plain text.\n")

    assert is_binary_file(p) is False
