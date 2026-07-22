import subprocess
from pathlib import Path
import pytest
from academy_auto.orchestrator import _count_diff_lines, _commit_and_pr, _list_changed_files


def _git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


@pytest.fixture
def repo(tmp_path):
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test")
    (tmp_path / "seed.txt").write_text("base\n")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-m", "seed")
    return tmp_path


def test_list_changed_files_reports_new_and_modified(repo):
    (repo / "a.txt").write_text("neu\n")
    (repo / "seed.txt").write_text("base\nmehr\n")
    files = _list_changed_files(None, repo)
    assert "a.txt" in files
    assert "seed.txt" in files


def test_count_diff_lines_counts_added_lines(repo):
    (repo / "a.txt").write_text("eins\nzwei\ndrei\n")
    n = _count_diff_lines(None, repo)
    assert n >= 3


def test_commit_and_pr_creates_commit(repo):
    (repo / "b.txt").write_text("inhalt\n")
    result = _commit_and_pr(None, repo, "meine Aufgabe")
    assert result is True
    log = subprocess.run(["git", "-C", str(repo), "log", "--oneline"], capture_output=True, text=True)
    assert "meine Aufgabe" in log.stdout
