# BUG-008 — Pilot scripts can wire the wrong project / silently misconfigure a remote worktree

| | |
|---|---|
| **Severity** | MEDIUM |
| **Backlog item** | A4/G — worktree isolation for agent execution (follow-ups from BUG-001 review) |
| **Origin commit** | `8a6e9ed3` |
| **Files** | `scripts/create-pilot-company.sh`, `scripts/create-pilot-plan.sh` |
| **Category** | Correctness / Error Handling |
| **Status** | Fixed |

## Summary

Three residual A4/G findings, all in the project-selection path that BUG-001 hardened on the
write side:

1. **Wrong-project selection (M1).** Both scripts picked `list[0]?.id` — the *first* project the
   API returns, with no filter. If the company already has an unrelated project (a prior failed run,
   a shared company), the plan is wired to the wrong project and inherits the wrong (or no)
   `git_worktree` policy. Silent.
2. **Remote-cwd misconfiguration (M2).** The project workspace `cwd` is `$REPO_ROOT`, resolved on the
   machine running the script. If `API_BASE` points at a server on a different host/filesystem, that
   path does not exist server-side and worktree provisioning fails with a non-obvious error. No
   guard warned about this.
3. **Swallowed projects-GET (M3).** `create-pilot-company.sh`'s idempotency check still used
   `curl ... 2>/dev/null || echo '[]'`, so a server/network error looked identical to "company has no
   project," and the script proceeded to create a second project (or misbehave).

## Fix

- **M1** — select the project named `"Pilot"` (the name both scripts create) instead of `list[0]`.
  `create-pilot-plan.sh` falls back to `list[0]` for back-compat when a single, differently-named
  project exists.
- **M2** — warn when `API_BASE` is not `localhost`/`127.0.0.1`, stating the `cwd` must exist on the
  server's filesystem.
- **M3** — make the idempotency GET fatal on request failure (matches the BUG-001 treatment of the
  other curl calls); an empty `[]` from a healthy server stays a normal "no existing project" path.

## Verification

- `bash -n` clean on both scripts.
- Trace: fresh company → GET 200 `[]` → no match → create project (unchanged happy path). Company
  with a stray non-"Pilot" project → no longer mis-selected. Remote `API_BASE` → warns before
  creating. GET request failure → exits 1 instead of fabricating `[]`.

## Not fixed (verified not a bug)

- A3 review L3 ("incident-name space splitting in `read IFS=' '`") — bash `read a b c` assigns all
  remaining fields, including embedded spaces, to the final variable, so scope names with spaces are
  preserved. No change needed.
