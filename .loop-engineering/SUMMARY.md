# Loop Engineering Summary

## Verdict

partial

## Completed

- configured loop run completed through iteration 1

## Verification

- passed: targeted_tests, diff_check
- blocked: none
- failed: none

## Commits

- Loop engineering: Fix exact scoped npm plugin installs and pass the real Paperclip version into plugin compatibility checks.

## Remaining

- line 3 [local-fixable] Parse `@scope/name@version` before resolving the installed package directory.
- line 4 [local-fixable] Preserve unscoped, scoped-unversioned, local-path, tag, range, and `--version` installs.
- line 5 [local-fixable] Pass the detected Paperclip server version to plugin compatibility checks.
- line 6 [local-fixable] Add regression tests for install parsing and host-version selection.
- line 7 [local-fixable] Run targeted tests, typecheck, and build gates.
- line 8 [out-of-repo] Push an upstream pull request with the full Paperclip template.

## External Blockers

- none

## Next Start

- remaining checklist items require another iteration or external action
