from pathlib import Path
from academy_auto.triage.scan import Candidate, iter_source_files, scan_todos, scan_skipped_tests


def _write(root: Path, rel: str, content: str):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def test_iter_source_files_excludes_vendor_dirs(tmp_path):
    _write(tmp_path, "src/App.tsx", "x")
    _write(tmp_path, "node_modules/pkg/index.js", "x")
    _write(tmp_path, "ios/Pods/Foo.js", "x")
    _write(tmp_path, "README.md", "x")  # falsche Endung
    files = iter_source_files(tmp_path)
    assert "src/App.tsx" in files
    assert all("node_modules" not in f for f in files)
    assert all("ios/Pods" not in f for f in files)
    assert "README.md" not in files


def test_scan_todos_finds_todo_and_fixme(tmp_path):
    _write(tmp_path, "src/a.ts", "const x = 1; // TODO Feld validieren\nconst y = 2; // FIXME leak\nconst z=3;\n")
    cands = scan_todos(tmp_path)
    keys = {c.key for c in cands}
    assert "todo:src/a.ts:1" in keys
    assert "todo:src/a.ts:2" in keys
    assert len(cands) == 2
    c = next(c for c in cands if c.key == "todo:src/a.ts:1")
    assert c.source == "todo"
    assert c.raw_priority == 10
    assert "validieren" in c.text


def test_scan_skipped_tests_finds_skip_markers(tmp_path):
    _write(tmp_path, "src/a.test.ts", "describe('x', () => {\n  it.skip('later', () => {});\n  xit('nope', () => {});\n});\n")
    cands = scan_skipped_tests(tmp_path)
    keys = {c.key for c in cands}
    assert "skip:src/a.test.ts:2" in keys
    assert "skip:src/a.test.ts:3" in keys
    assert all(c.source == "skip" and c.raw_priority == 30 for c in cands)
