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


def test_iter_source_files_keeps_paths_with_substring_of_excludes(tmp_path):
    # "distance.ts" enthält "dist", darf aber NICHT ausgeschlossen werden
    _write(tmp_path, "src/distance.ts", "// TODO fix\n")
    _write(tmp_path, "src/distribution/index.ts", "// TODO fix\n")
    _write(tmp_path, "dist/bundle.js", "// TODO ignored\n")  # echtes dist-Segment -> raus
    files = iter_source_files(tmp_path)
    assert "src/distance.ts" in files
    assert "src/distribution/index.ts" in files
    assert all(not f.startswith("dist/") for f in files)


def test_scan_todos_in_substring_path_is_found(tmp_path):
    _write(tmp_path, "src/distance.ts", "const x=1; // TODO wichtig\n")
    cands = scan_todos(tmp_path)
    assert "todo:src/distance.ts:1" in {c.key for c in cands}


def test_scan_skipped_tests_ignores_non_test_files(tmp_path):
    _write(tmp_path, "src/app.ts", "it.skip('x', () => {});\nxit('y', () => {});\n")
    assert scan_skipped_tests(tmp_path) == []


from academy_auto.triage.scan import scan_tsc, scan_lint


def _proc(stdout="", returncode=0):
    class R:
        pass
    r = R()
    r.stdout = stdout
    r.stderr = ""
    r.returncode = returncode
    return r


def test_scan_tsc_parses_errors():
    tsc_out = (
        "src/App.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
        "src/lib/u.ts(3,1): error TS2531: Object is possibly 'null'.\n"
        "Found 2 errors.\n"
    )
    cands = scan_tsc(None, runner=lambda *a, **k: _proc(stdout=tsc_out, returncode=2))
    keys = {c.key for c in cands}
    assert "tsc:src/App.tsx:12:TS2322" in keys
    assert "tsc:src/lib/u.ts:3:TS2531" in keys
    assert all(c.source == "tsc" and c.raw_priority == 50 for c in cands)


def test_scan_tsc_fail_soft_on_crash():
    def boom(*a, **k):
        raise FileNotFoundError("npx not found")
    assert scan_tsc(None, runner=boom) == []


def test_scan_lint_parses_json():
    lint_json = (
        '[{"filePath":"/repo/src/a.ts","messages":['
        '{"line":4,"ruleId":"no-unused-vars","message":"x unused","severity":1}]}]'
    )
    cands = scan_lint(None, runner=lambda *a, **k: _proc(stdout=lint_json, returncode=1), repo_root="/repo")
    assert len(cands) == 1
    c = cands[0]
    assert c.key == "lint:src/a.ts:4:no-unused-vars"
    assert c.source == "lint" and c.raw_priority == 45


def test_scan_lint_fail_soft_on_bad_json():
    assert scan_lint(None, runner=lambda *a, **k: _proc(stdout="not json", returncode=1), repo_root="/repo") == []


def test_scan_lint_null_rule_id_becomes_unknown():
    lint_json = '[{"filePath":"/repo/src/a.ts","messages":[{"line":9,"ruleId":null,"message":"Parsing error","severity":2}]}]'
    cands = scan_lint(None, runner=lambda *a, **k: _proc(stdout=lint_json, returncode=1), repo_root="/repo")
    assert len(cands) == 1
    assert cands[0].key == "lint:src/a.ts:9:unknown"


def test_scan_tsc_reads_errors_from_stderr():
    tsc_err = "src/x.ts(2,3): error TS2531: Object is possibly 'null'.\n"
    def runner(*a, **k):
        class R:
            stdout = ""
            stderr = tsc_err
            returncode = 2
        return R()
    cands = scan_tsc(None, runner=runner)
    assert "tsc:src/x.ts:2:TS2531" in {c.key for c in cands}


from academy_auto.triage.scan import scan_issues


def test_scan_issues_parses_gh_json():
    gh_json = '[{"number":42,"title":"Login-Flow bricht ab","labels":[{"name":"bug"}],"body":"..."},{"number":7,"title":"Dark Mode","labels":[],"body":""}]'
    cands = scan_issues(runner=lambda *a, **k: _proc(stdout=gh_json, returncode=0))
    keys = {c.key for c in cands}
    assert "issue:42" in keys
    assert "issue:7" in keys
    c = next(c for c in cands if c.key == "issue:42")
    assert c.source == "issue" and c.raw_priority == 20 and c.line == 0 and c.file == ""
    assert "Login-Flow" in c.text


def test_scan_issues_fail_soft_when_gh_missing():
    def boom(*a, **k):
        raise FileNotFoundError("gh not found")
    assert scan_issues(runner=boom) == []
