# Hermes Image Inspection — v2026.6.19 (assumed)

> **This file documents ASSUMED image structure based on the previous change's verified working build, not a fresh live inspection.**
>
> **Smoke test in PR #3 is the runtime proof.** The `hermes_runtime_verify` Dockerfile stage in PR #2 will re-validate these paths against a freshly-pulled image at build time; if any probe fails, PR #2 must be re-scoped with live evidence.

## Context

A live `docker run --rm nousresearch/hermes-agent:v2026.6.19 ...` inspection is not available in this sandbox. This record intentionally quotes the design's assumed layout and ties it back to the previous change's audit (`hermes-fork-audit.md`, rows 1, 3, 4, 13), which already validated the runtime against an image that booted Hermes under `HOME=/paperclip`. That audit was the last change to deploy a real `hermes_local` adapter successfully on this fork, so its observed paths are the working baseline.

If the upstream image is retagged or restructured between PR #1 and PR #2, the paths below MUST be re-verified by `docker run --rm nousresearch/hermes-agent:<tag> ls /opt/hermes/.venv/bin/` before PR #2's verification stage is written. The verification stage is designed to fail fast in that case.

## Probes and assumed outcomes

Each probe below lists the command that PR #2's `hermes_runtime_verify` stage must execute, the assumed result, and the source of the assumption.

| # | Probe | Assumed result | Source of assumption |
|---|-------|----------------|----------------------|
| 1 | `docker pull nousresearch/hermes-agent:v2026.6.19` | OK | `hermes-fork-audit.md` line 8 pins the tag; previous change deployed against it. |
| 2 | `ls -la /opt/hermes` | OK — directory present | Design §6 + previous change audit row 1. |
| 3 | `ls -la /opt/hermes/.venv/bin/` | OK — directory contains hermes binaries | Design §6 assumes this layout; matches previous change's successful boot. |
| 4 | `test -f /opt/hermes/.venv/bin/hermes` | OK | Design §6 (verification stage); required for `hermes --version` probe in Dockerfile. |
| 5 | `test -f /opt/hermes/.venv/bin/hermes-agent` | OK | Design §6 (verification stage); required by `PHI-S4` (fail-fast path contracts). |
| 6 | `test -f /opt/hermes/.venv/bin/hermes-acp` | OK | Design §6 (verification stage); required by `PHI-S4`. |
| 7 | `test -f /usr/local/bin/uv` | OK | Design §6; required by Hermes Python venv workflow. |
| 8 | `test -f /usr/local/bin/uvx` | OK | Design §6; required by Hermes Python venv workflow. |
| 9 | `test -d /opt/hermes/hermes_cli/web_dist` | UNVERIFIED — keep optional `HERMES_WEB_DIST` out of Dockerfile unless PR #2 inspection proves it | Design §6 says "keep only if inspection proves they exist"; previous change did not advertise this path. |
| 10 | `test -d /opt/hermes/.playwright` | UNVERIFIED — keep optional `PLAYWRIGHT_BROWSERS_PATH` out of Dockerfile unless PR #2 inspection proves it | Same reasoning as #9; previous change did not advertise this path. |
| 11 | `hermes --version` | OK (exits 0) | Previous change's audit (rows 3, 11) confirmed upstream `wrappedOnLog` works; `hermes --version` already ran successfully in the previous Dockerfile build. |

## What re-verifies if the image was retagged

PR #2's `hermes_runtime_verify` Dockerfile stage will re-run probes 2–8 against the freshly-pulled image at build time. If any of those probes fail, the build aborts before production stage starts, surfacing the drift immediately. Operators see:

```
ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref ...: "/opt/hermes/.venv/bin/hermes-agent": not found
```

at build time rather than at runtime — exactly the failure mode this change is designed to prevent.

## Optional env paths (probes 9, 10)

Both `HERMES_WEB_DIST` and `PLAYWRIGHT_BROWSERS_PATH` are intentionally **excluded** from PR #2's Dockerfile and from `doc/DOCKER.md` until live inspection proves they exist in `v2026.6.19`. The previous change never advertised either path; design §6 says they MUST be pruned rather than preserved unverified. If PR #2's runtime smoke proves either path exists, it is added back as a follow-up PR, not silently re-enabled here.

## Open follow-up for PR #2

When PR #2 starts, the operator applying this change should:

1. Run `docker pull nousresearch/hermes-agent:v2026.6.19` (assumed to work — network access required).
2. Run each probe in `/opt/hermes` and `/usr/local/bin` manually against the freshly-pulled image.
3. If any of probes 4–8 fail, STOP and report — do not amend the Dockerfile to use guessed alternate paths. That requires a separate decision.
4. If probes 9 and 10 succeed, file a separate follow-up issue to add the optional env vars; do not include them in PR #2.

This file's role ends here. The runtime proof of the assumed paths lives in PR #3's `scripts/docker-hermes-smoke.sh`.