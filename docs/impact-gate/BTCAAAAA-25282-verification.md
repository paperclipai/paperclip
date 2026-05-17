# Impact Gate Verification — BTCAAAAA-25282

**Date**: 2026-05-13
**Agent**: AutomationEngineer

## Issue

Impact Gate flagged BTCAAAAA-7235 regression tests as failing because the test file did not exist. The Impact Gate worker auto-created this blocking issue (BTCAAAAA-25282).

## Root Cause

`tests/bug_regression/test_btcaaaaa_7235_regression.py` did not exist. When the Impact Gate runner resolved `BTCAAAAA-7235` to its test file path, the file was missing → status "MISSING" → gate FAIL → blocking issue created.

BTCAAAAA-7235 fixed a bug where `_is_source_file()` in `git_extractor.py` had an allowlist prefix check that rejected bare root-level `.py` files (like `setup.py`). The fix moved the allowlist from `git_extractor._is_source_file()` to `comment_extractor.extract_files_from_text()` only.

## Fix

Commit `c11f0fc4` — created `tests/bug_regression/test_btcaaaaa_7235_regression.py` re-exporting canonical tests from `test_git_extractor.py` and `test_comment_extractor.py`, added regression-specific test cases, and wired into `test.yml`.

### Changes

| File | Change |
|---|---|
| `tests/bug_regression/test_btcaaaaa_7235_regression.py` | New — re-exports 6 test classes (98 test cases) |
| `tests/test_touch_index/test_git_extractor.py` | +2 tests: `test_bare_root_level_py`, `test_root_level_py_in_tests` |
| `tests/test_touch_index/test_comment_extractor.py` | +10 tests: `TestHasAllowedPrefix` (8 tests) + 2 `TestExtractFilesFromText` tests |
| `.github/workflows/test.yml` | +1 line: wired `test_btcaaaaa_7235_regression.py` into CI |

## Impact Gate Verification

```
$ python scripts/impact_gate_runner.py --bugs BTCAAAAA-7235
```

| Metric | Value |
|---|---|
| Status | **PASS** |
| Total tests | 98 |
| Passed | 98 |
| Failed | 0 |
| Errors | 0 |

### Key Regression Tests

- `TestIsSourceFile::test_bare_root_level_py` — `_is_source_file("setup.py")` → `True` ✓
- `TestIsSourceFile::test_root_level_py_in_tests` — `_is_source_file("tests/conftest.py")` → `True` ✓
- `TestHasAllowedPrefix::test_rejects_bare_filename` — `_has_allowed_prefix("setup.py")` → `False` ✓
- `TestHasAllowedPrefix::test_allows_src` — `_has_allowed_prefix("src/foo/bar.py")` → `True` ✓
- `TestExtractFilesFromText::test_rejects_bare_filename_without_source_prefix` — bare `setup.py` in comment → `[]` ✓
- `TestExtractFilesFromText::test_allows_path_with_known_prefix` — `src/git_extractor.py` → correct extraction ✓

## CI Wiring Confirmed

`.github/workflows/test.yml:116`:
```
tests/bug_regression/test_btcaaaaa_7235_regression.py \
```

## Resolution

**Verdict**: Impact Gate correctly identified a missing test file gap. The gap has been closed with a full regression test suite and CI wiring.

Status: **READY TO CLOSE**
