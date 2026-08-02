# TSMC-18503 — MC Portfolio Intake dispatch env restore

## Process checked
- TSKB0002 Portfolio Daily-Summary Reporting
- TSKB0036 Mission Control Intercompany Comms & Ack Chain
- TSKB0232 Portfolio Intake Bearer Rotation fan-out rule
- Skill: mc-portfolio-comms

## Wake note
Corrective reassign from Engineer-Hermes (queued wakes, no hermes_local processing) to GLaD0S-Hermes live path (TSMC-18608).

## AC1 — runtime env
| Key | Before | After |
|---|---|---|
| `MC_PORTFOLIO_INTAKE_BEARER` | absent in hermes_local process env | present, len=48, not placeholder |
| `MC_PORTFOLIO_INTAKE_URL` | absent | public fire `badfffb5272d4320ecd24887` |
| `MC_COMPANY_SLUG` | absent | `tsmc` |
| `MC_API_URL` | absent | local Paperclip API |
| `PAPERCLIP_COMPANY_ID` | harness company context | explicit TSMC uuid |

Governed source: CTO `instructions/.secrets/portfolio-intake-bearer` (mode 600, mtime 2026-07-29 local, matches trigger `lastRotatedAt` 2026-07-29T14:10:42.263Z).

## AC2 — rebind
- Loaded bearer from CTO governed file (no new rotation; trigger already live).
- Durable lane rebind for GLaD0S-Hermes:
  - `agents/b8e57a44-…/instructions/.env.mc.local` (mode 600, TSKB0002 shape)
  - `agents/b8e57a44-…/instructions/.secrets/portfolio-intake-bearer` (mode 600 mirror)
  - `agents/b8e57a44-…/instructions/scripts/load-mc-portfolio-env.sh` (prefers live CTO file over stale local)
- Company secret API list returned `403 Board access required` from agent JWT. Fan-out of company secret VALUE copies was not required this run because trigger + CTO file already matched the Jul-29 rotation (TSKB0232 steps 1–2 current).

## AC3 — transport proof
### Intake primary path
- POST `…/routine-triggers/public/badfffb5272d4320ecd24887/fire`
- HTTP **202**
- run id `dad20d33-9ea8-4191-bca3-e8fac712b1d6`
- status `skipped` / `failureReason=machine_handshake` (expected for liveness handshake; auth accepted)
- evidence: `work-products/TSMC-18503/intake-probe.json`

### Missing-reporter reminder pings (parent TSMC-18493: TSK, TSB, TSC, TSR)
Via governed `opco-dispatch.py` (auto→webhook after outbox 404), refs `daily-summary-reminder:2026-07-29:<slug>:catchup-TSMC-18503`:

| OpCo | final | primary HTTP | exit |
|---|---|---|---|
| tsk | primary | 202 | 0 |
| tsb | primary | 202 | 0 |
| tsc | primary | 202 | 0 |
| tsr | primary | 202 | 0 |

Evidence: `work-products/TSMC-18503/reminders/*-result.json` and `reminders/summary.json`.

## AC4 — parent handback
Comment left on TSMC-18493 with proof ids and remaining intake close path (await OpCo summaries / compile).

## KB delta
No new process invention. Confirmed existing TSKB0002/TSKB0232 path works when CEO hermes_local loads the CTO bearer file. Reusable fact: agent process env does not auto-project `MC_*` — use `load-mc-portfolio-env.sh` or `.env.mc.local` at run start. Optional one-line fold into TSKB0002 gotchas if desired; not a new KB class.
