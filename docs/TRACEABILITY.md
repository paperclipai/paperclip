# Traceability

This file maps internal issue identifiers to the source files they changed and the commits that landed the work. It exists because squash-import commits sometimes carry unrelated upstream titles — use this table to trace issue → code → commit without git-blame.

| Issue | Description | Files Changed | Commit |
|-------|-------------|---------------|--------|
| SAG-810 | Runtime API URL selection fix — ensure agents resolve the correct base URL at startup | `server/src/runtime-api.ts`, `server/src/runtime-api.test.ts` | `0096b56` (note: commit title is unrelated — upstream squash import) |
