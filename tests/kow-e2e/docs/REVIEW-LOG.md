# Adversarial review log — Paperclip+kow smoke test

Radek asked for 3 pre-implementation adversarial sweeps + fixes, then 3 more
post-implementation. Provider reality during this session (2026-10-08):

- **Sweep 1 (design): Oracle / codex `gpt-6-astra` (cross-vendor, OpenAI-family).**
  Completed, 10 concerns (C1-C10), ALL accepted and applied → SPEC v2. 87s.
- **Codex degraded thereafter.** kow's transparent MITM proxy presents its own
  cert for `wss://chatgpt.com/backend-api/codex/responses`; codex (Rust, ignores
  NODE_EXTRA_CA_CERTS/SSL_CERT_FILE for its WS stack) rejects it as UnknownIssuer,
  retries 5x, falls back to HTTPS, and the proxy cuts the long reasoning stream
  before completion. Confirmed the MITM is forced (persists even with HTTP(S)_PROXY
  unset). Short calls (~19s) succeed; long review streams (>~120s) do not.
- **OpenAI metered fallback unavailable:** account returns 429 insufficient_quota.
- **Decision:** cross-vendor Oracle is environmentally unavailable for heavy
  reviews this session. Remaining sweeps use **Max (Anthropic-family)**, the
  sanctioned second-look/security-boundary reviewer. Trade-off recorded openly:
  in-family review shares some blind spots with the author; it is NOT a
  substitute for the eventual cross-vendor pass. TODO: re-run a true cross-vendor
  Oracle sweep once codex WS trusts the kow CA (or on a host without the MITM),
  before this harness is used as external evidence for the ADR-0005 PR.

## 2026-10-19 — Oracle cross-vendor sweep (implementation phase), round 2

Adversarial cross-vendor (Oracle) review of the implemented harness. Six
concerns accepted and fixed in `guest/` + `harness/` + `tests/` (no VM boot
needed to apply; parent verifies live):

- **C1 (HIGH)** — the no-leak scan targeted the `kow run` launcher pid, not the
  agent. `agent.mjs` now writes its own `process.pid` to
  `agent-<label>.agentpid` at startup; `collect-evidence.sh` scans that pid's
  `/proc/<pid>/environ` + `/proc/<pid>/cmdline`.
- **C2 (HIGH)** — an alive agent with an unreadable environ scored 0 hits =
  "clean". `collect-evidence.sh` now emits `env_readable`/`cmdline_readable`;
  a live pid whose environ/cmdline cannot be read is a collection failure
  (non-zero exit) and the test fails, never greens vacuously.
- **C9 (MEDIUM)** — `count-audit.sh` silently skipped malformed JSON and only
  counted the bound injection. It now fails (exit 2) on any malformed line and
  emits `{matching,total_allowed,unexpected,malformed}`; smoke-core asserts
  `matching==1` AND `unexpected==0` (no OTHER allowed injection).
- **C8 (HIGH)** — no negative control, so selectivity was unproven. smoke-core
  adds A5: a second agent run to `POST /other` (unbound path) on the bound host;
  asserts the wire carried the placeholder fingerprint (not the fixture) and the
  allowed counts stayed `matching==1, unexpected==0`.
- **C6 (MEDIUM)** — teardown killed by bare pid (reuse risk). The manifest now
  records the qemu start-time (`/proc/<pid>/stat` field 22) and teardown only
  SIGKILLs when the live start-time still matches.
- **C4 (partial)** — teardown now best-effort removes the overlay, run dir, and
  manifest after a confirmed kill. Full crash-reaper (C5) remains deferred (see
  SPEC §11).

Provider note: run as a BUILD-mode cross-vendor (Forge/OpenAI-family) fix pass;
the review findings themselves came from the Oracle sweep listed above.

## 2026-10-19 — Evidence-soundness sweep (implementation phase), round 3

A second adversarial review targeted soundness holes in the evidence collection
itself (the live run already passed A1/A2a/A3 and the A5 negative control, so
selectivity was proven; this sweep asked whether the collectors could be fooled
or could green vacuously). Six findings fixed in `guest/` + `tests/`; new
finding IDs are scoped to this sweep and do not reuse the round-2 labels above.

- **C1 (HIGH, self-inflicted leak)** — `collect-evidence.sh` passed the real
  secret as a `grep` argument, so while the agent was alive the secret was
  recoverable from `/proc/<collector-pid>/cmdline` (world-readable). The pattern
  is now fed to `grep -f -` on stdin (`printf '%s' "$real" | LC_ALL=C grep -Fac
  -f - "$file"`) for EVERY scan — environ, cmdline, result file, and the new
  agent-log scan. The 0=hit / 1=clean / 2=unreadable rc classification is
  preserved under `pipefail`.
- **C2 (HIGH)** — the agent's own run log `agent-<label>.log` is an
  agent-visible channel that was never scanned. `collect-evidence.sh` now scans
  it and emits `log_readable`/`log_hits`; an existing-but-unreadable (or missing)
  log is a COLLECTION FAILURE (non-zero exit). smoke-core A2a asserts
  `log_readable===true && log_hits===0`.
- **C3 (MEDIUM)** — the result-file scan discarded its readability flag, so a
  size>0 result file that then failed to read still counted clean. It now
  carries `result_readable`; a found-but-unreadable result is a collection
  failure. smoke-core asserts `result_readable===true`.
- **C4 (HIGH)** — A2a trusted agent-controlled evidence without identity checks
  and the collector's NONCE argument was unused. Now (a) the result file's JSON
  `nonce` must equal the passed nonce (`result_nonce_ok`) and (b) the scanned
  pid's executable must be node and the process owned by the `agent` user
  (`readlink /proc/<pid>/exe` + `stat -c %U /proc/<pid>` → `agent_identity_ok`).
  smoke-core A2a asserts both true — a different live process plus an arbitrary
  clean result can no longer satisfy A2a.
- **C6 (HIGH)** — the A5 negative control only inspected the LAST upstream log
  line for the control nonce, so an earlier unbound request carrying the REAL
  credential followed by a placeholder request would have passed. The check now
  aggregates EVERY received-log line for the control nonce in-guest and asserts
  at least one line exists, every line carries the placeholder fingerprint, and
  none carries the fixture fingerprint (fingerprints only; raw secret/header
  never leaves the guest).
- **C5 (MEDIUM)** — `count-audit.sh` tied the audit record to the bound request
  only by `secret_name` + host. It now ALSO pins `destination.path_prefix`
  (`/echo`) and method (`POST`) when present, tolerantly (a field is used only
  when present in the record; path is compared prefix-wise), so the A3/A5
  assertions are tightened without hard-failing on an absent field.

Not built this sweep (remain disclosed-PENDING in SPEC §11): the full
crash-reaper / orphan sweeper and the §5 network egress-hermeticity (nftables)
proof.

Provider note: run as a BUILD-mode cross-vendor (Forge/OpenAI-family) fix pass.
VM-gated assertions (live agent identity, the all-lines A5 aggregation, and the
path_prefix/method audit pinning against real kow output) were NOT booted here;
the parent verifies them live.

## 2026-10-19 — At-rest + teardown-robustness sweep (implementation phase), round 4

A third adversarial review (post the all-green live round: A1, A2a, A3, and the
A5 all-lines negative control all passed on a real VM). It targeted the one claim
with no assertion behind it (at-rest confidentiality), two teardown holes, and an
A5 denominator gap. Finding IDs are scoped to this sweep and do not reuse earlier
labels. Five fixed in `tests/` + `harness/` + `guest/`; two documented only.

- **C2 (HIGH) — nothing asserted the agent cannot read the secret at rest.**
  smoke-core now runs A7: as the in-guest `agent` user, `cat` BOTH
  `kowd/static-secrets.yaml` AND `upstream/received.log`; it compares only
  in-guest success/failure (contents never leave the guest) and requires BOTH
  reads to fail with a non-zero rc. A readable file (rc 0) is a real FAIL; a
  missing rc marker is RED. The fuller discovery sweep stays spec'd (SPEC §4 A7).
- **C5 (HIGH) — provisioning failure orphaned the guest.** `provision()` was
  awaited BEFORE the try/finally, so an SSH-readiness failure after qemu boot
  skipped teardown. The run nonce is now generated in smoke-core via `newNonce()`
  and threaded into `provision(nonce)` → `up(nonce)`; the provision call moved
  INSIDE the try, and the finally tears down by reading the manifest for that
  nonce even when `provision()` threw and returned no ctx. The identity-guarded
  SIGKILL + overlay/runDir/manifest cleanup is preserved.
- **C6 (MEDIUM) — teardown masked its own failure.** It printed "killed + swept"
  from the initial identity check alone and swallowed kill/removal errors. It now
  re-checks that the qemu process is actually gone (alive-but-different-identity
  counts as gone — pid reuse) and that each of overlay/runDir/manifest was removed
  (`existsSync`); if qemu survived the SIGKILL or any path remains, it fails an
  assertion (non-zero exit) instead of printing success. It only fails when
  teardown genuinely failed, so a clean green is never masked.
- **C7 (MEDIUM) — A5 denominator dropped empty-fingerprint lines.** The control
  pipeline pre-filtered to `token_sha256_12` values of exactly 12 hex before
  counting, so an unauthorized empty-fingerprint request could pass "every control
  line carried the placeholder". The denominator is now ALL received-log lines for
  the control nonce; the fingerprint is extracted per line (empty allowed) and an
  empty/absent fingerprint counts as a FAIL. Asserts `total>=1`,
  `placeholder==total`, `fixture==0`, `other==0`, `empty==0`.
- **C4 (MEDIUM) — audit path match was bidirectional-prefix.** `count-audit.sh`
  treated `/echo-other` and `/` as matching `/echo`. When the record carries a
  `path_prefix` it is now matched EXACTLY against the bound path; the
  "field absent ⇒ don't apply" tolerance is kept. The parse emits
  `seen_paths`/`seen_methods` so a live exact-match miss prints the real stored
  path for the parent to diagnose. This must not break the live A3/A5 (both green
  with the bound path `/echo`); if kow's stored path differs from `/echo`, the
  diagnostic fields surface it.
- **C1 (documented only)** — the agent's `curl` child is not scanned separately:
  by construction the agent holds only the placeholder and kow injects on the
  wire, so the curl child inherits the placeholder, never the real secret. Noted
  in SPEC §4 A2a.
- **C3 (documented only)** — network egress hermeticity (§5 nftables) and the full
  crash-reaper / orphan sweeper remain disclosed-PENDING in SPEC §11.

Provider note: run as a BUILD-mode cross-vendor (Forge/OpenAI-family) fix pass.
VM-gated items NOT booted here — the parent verifies live: A7's actual
permission behavior against real kowd/upstream file modes, the C4 exact
`path_prefix` value kow stores, and the C7 all-line A5 aggregation against real
upstream output.

## 2026-10-19 — Greptile P2 round (safe-refresh + test isolation)

Three P2 Greptile findings fixed (5/5, last open P2s) in `harness/setup-base.ts`
+ `tests/lib.test.ts`. `bun test` 11/11 green; `~/.cache/paperclip-kow-smoketest/runs/`
unchanged before/after the run.

- **P2 (setup-base, failed refresh deletes working image)** — removed the
  `rmSync(dest)` that destroyed a stale-but-present cache before downloading its
  replacement. `dest` is now never deleted; a freshly downloaded candidate is
  verified for BOTH size and sha256 and only then `renameSync`d over `dest`. A
  bad existing image plus a failed/mismatched download now leaves `dest` intact
  and `die()`s with a message noting the cached image was left untouched.
- **P2 (setup-base, concurrent runs clobber shared download)** — the fixed
  `${dest}.part` is replaced by a per-process unique temp
  (`${dest}.<pid>.<rand>.part`), so two concurrent `setup` runs no longer write
  the same file; each verifies its own temp and atomically renames over `dest`. A
  `process.on("exit")` handler removes the unique temp on every exit path
  (including the internal `die()` in curl/sha failures). The idempotent
  already-cached-and-valid fast path is unchanged.
- **P2 (lib.test, unit tests leave fake runs)** — the `beforeAll`/`afterAll`
  `mkdtempSync`+`rmSync` isolation via `PKST_SCRATCH` was already present and
  working; the round-trip test now asserts `manifestPath(nonce)` resolves under
  the temp scratch BEFORE it writes, so a broken isolation fails loudly instead
  of silently polluting the real runs dir.
