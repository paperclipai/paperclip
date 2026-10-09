# Repository skill packages

Outcome: GitHub imports can preserve a complete repository while independently selecting library entrypoints. Original authored files remain unchanged. Standalone skill-directory imports remain supported. Imports do not execute setup scripts.

Branch: `codex/skill-repository-packages`, based on `origin/master` at `7333e4eba8`.

Acceptance: evaluation prose is accepted; dynamic execution checks remain; repository snapshots preserve shared references, binaries, executable files and credits through runtime copying; shared-file updates produce coherent pinned versions; invalid shared content blocks the package; the existing import dialog explains selection, files and requirements and supports inspecting both.

Implementation: one immutable, company-scoped repository snapshot is referenced by each imported skill version. Runtime projections contain a generated discovery entrypoint and the untouched tree under `.paperclip-repository/`, so all existing adapters carry the dependencies without introducing host-only symlinks. Projections may duplicate package files for multiple enabled entrypoints; the database stores each package once. Optional `paperclip.skills.json` declares version 1, public `skills` entrypoint paths and `requirements` text. It never runs installation commands.

Verification: 55 focused scanner, delivery and UI tests pass. Server and UI TypeScript checks pass. Design-token gates pass. Scanning the pinned example distribution accepts all 62 skills without changing their text. A real Codex discovery probe exposes only the selected entrypoint while retaining the complete repository as supporting files.

Limits: PostgreSQL lifecycle tests are committed but skipped locally because macOS shared-memory IDs are exhausted (`shmget: No space left on device`). The full repository typecheck and build include a cold Rust release build; broad checks and the browser walkthrough are still in progress. Do not treat the database lifecycle or full runtime agent invocation as verified by the filesystem/discovery checks.
