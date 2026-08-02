# TSR-4704 — board decision packet (status after hire)

## Hire gate — SATISFIED
Agent **CV-Review-Grok-R2** exists (`e73544da-2ff4-4370-8510-79bcefc24ffd`), applied via TSR-4750 / Athena-Codex from `hire-payload.json`.
Pending hire `request_confirmation` is obsolete (superseded by completed hire) and should be cancelled.

## Evidence

| Gate | Status |
|---|---|
| R2 artifact located + SHA-verified | done |
| Dev-suite validation meanQ ≥ bare incumbent | **PASS** 1.0000 ≥ 0.8974 (n=30) |
| Shadow-ready agent hired + config verified | **done** |
| Post-hire smoke (clean-calibration) | **PASS** |
| Live shadow 3 orders (TSR-4709) | armed / backlog — **0/3** orders |
| Paid primary flip | **deferred** — separate confirmation after shadows |

## What we will ask next (NOT yet)
After TSR-4709 logs 3 real-order shadow comparisons, file a **new** `request_confirmation` for paid primary flip of the €29 CV-polish reviewer routing. Do **not** flip now.

## Why not flip paid routing now
1. Scope step 3 (shadow) has 0/3 real orders — cannot fabricate.
2. €29 wedge is live paid product; one-way until reverted.
3. Production primary today is Gemini (TSBC-1639 primary_stands).

## Artifacts
- `cv-review-agent-file-R2.md` (sha fd189e4b…)
- `lane-spec.json` / `hire-payload.json`
- `validation-evidence.md` / `post-hire-verification.md`
- `post-hire-agent-config.json`
- `post-hire-smoke-20260731T165000Z/`
- `shadow-sop.md` (agent id wired)
