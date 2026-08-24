# VOY-1413 Plan — Deploy Docs Site with Case Studies + Discord Link (Revised 2026-08-20 v10)

**Status**: ✅ **IN PROGRESS — Site restored. Discord link code done (deploy pending). Case studies code DONE in PR #6. Both deliverables NOT LIVE. COO delegated to coordinate execution (VOY-1498). FE woken on both children.**
**Author**: CEO (Voyonder)
**Date**: 2026-08-20 (v10: ~07:55 UTC — COO delegated VOY-1498 to wake CTO gate + coordinate FE. FE re-woken on VOY-1489 and VOY-1477. Verified live: / 200, /case-studies/ 308→404, no Discord link in footer. Both children NOT progressed since v9.)
**Current mode**: Delegation — plan complete, COO owns operational coordination via VOY-1498
**Previous plan approval**: v4 approved by founder (Ben, 05:19 UTC Aug 20) — scope, plan, and children accepted

### Children Status

| ID | Title | Status | Notes |
|---|---|---|---|
| VOY-1479 | Founder action: Restore voyonder.com P0 outage + root-cause | ✅ **done** | Site restored ~06:37 UTC, root cause: zombie docker-proxy PID 3951678, uptime monitoring installed, follow-ups VOY-1481/1482 in backlog |
| VOY-1476 | Add Discord link to voyonder.com footer | ✅ **done (code only)** | Code committed (c4b895b), CI passed, but **deploy to VPS-1 FAILED** — SSH broken pipe. Discord link NOT live. |
| VOY-1489 | Deploy Discord link — re-run GitHub Actions deploy | ⏳ **todo** | Assigned to Founding Engineer (57fa7e0e). CEO wake comment posted ~07:21 UTC with deploy instructions + manual fallback. |
| VOY-1477 | Create Voyonder-centric case studies page at /case-studies/ | ⚠️ **in_review** | **Implementation COMPLETE** — PR #6 (feat/voy-1477-case-studies, PraeSynBH/travel_itenerary_planning), mergeable, all CI checks green, 0 reviews. `app/case-studies/page.tsx` + footer nav link + sitemap. Awaiting CTO confirmation → Staff Engineer review → merge → deploy. Raised to **high** priority. |
| ~~VOY-1490~~ | ~~Create Voyonder-centric case studies page (dup)~~ | ❌ **cancelled** | Duplicate of VOY-1477 created at 07:16 in error. Cancelled ~07:22 UTC with explanation. All case studies work routes to VOY-1477. |
| VOY-1478 | Create Voyonder-centric case studies page (dup) | ❌ cancelled | Earlier duplicate of VOY-1477. |
| VOY-1417 | Docs verification for VOY-1413 | ✅ done | |

### Verified Live State (2026-08-20 heartbeat)

| URL | Status | Notes |
|---|---|---|
| https://voyonder.com/ | **200** | ✅ Full Voyonder landing page |
| https://voyonder.com/api/health | **200** | ✅ Health endpoint live |
| https://voyonder.com/api/health/live | **200** | ✅ Liveness check live |
| https://voyonder.com/documentation | **200** | ✅ Documentation page |
| https://voyonder.com/documentation/releases | **200** | ✅ Release notes |
| https://voyonder.com/case-studies/ | **404** | ❌ Route does not exist (308 redirect → 404) |
| https://voyonder.com/case-studies | **404** | ❌ Route does not exist |
| Discord link in footer | **NOT FOUND** | ❌ No Discord href in homepage HTML. Discord link was committed but never deployed. |
| https://discord.gg/m4HZY7xNG3 | **200** | ✅ Live independently (8,600+ members) — not linked from voyonder.com |

### What's Actually Left

#### 1. Discord link deploy (unblocked — site is back up)

The code change is done and committed to `main` (c4b895b, CI passed). The GitHub Actions deploy to VPS-1 failed with `client_loop: send disconnect: Broken pipe` — a pre-existing SSH connectivity issue (also hit by VOY-522 deploy).

**Now that VPS-1 is restored** (founder SSH'd in ~06:37 UTC), the deploy pipeline should be re-run. Options:
- **Re-run GitHub Actions**: The commit is on main. If the VPS_SSH_KEY secret is still valid, a re-triggered deploy should work now that the host is reachable.
- **Manual deploy**: If the SSH key is permanently broken, founder (Ben) can do a manual deploy from local machine (docker build --platform linux/amd64 → scp → ssh → docker load + compose up).

**Owner**: Founding Engineer (57fa7e0e-0557-4cde-9b76-6c84c2fe2f4e) or Founder (Ben) if SSH key is broken.

#### 2. Case studies page (/case-studies/) on voyonder.com — CODE DONE, awaiting review gates

**Implementation is COMPLETE** in **VOY-1477** (Founding Engineer):
- PR: https://github.com/PraeSynBH/travel_itenerary_planning/pull/6 (branch `feat/voy-1477-case-studies`)
- New page `app/case-studies/page.tsx` (Next.js App Router, Tailwind, dark-mode aware)
- Footer nav link added ("Case Studies" alongside Gallery, Pricing, Documentation)
- `/case-studies` added to `app/sitemap.ts`; JSON-LD structured data
- Content: 5 draft case studies grounded in Voyonder product capabilities (illustrative pending founder content direction)
- All CI checks pass (Type Check, Lint, Unit Tests, Build, CI Gate)

**Approved reference content** (from `doc/outreach/` in the paperclip repo, CEO-approved via VOY-1344):
- `doc/outreach/case-study-voyonder-travel.md` — Voyonder Travel — Customer Zero
- `doc/outreach/case-study-voyonder-operations.md` — Voyonder Operations on Paperclip
- `doc/outreach/case-study-trail-life.md` — Trail Life / Autonomous Agent Economy

**Remaining path (VOY-1477)**:
1. **CTO** — accept request_confirmation `9c27e7d8` (implementation + content direction approval) — ⏳ PENDING
2. **Staff Engineer** — code review of PR #6
3. **Founder (Ben)** — content direction for real customer stories (per plan gate 4; draft content is sufficient to ship)
4. **Founding Engineer** — merge PR #6 → main → GitHub Actions auto-deploy → verify `/case-studies/` live

**Owner**: Founding Engineer (57fa7e0e-0557-4cde-9b76-6c84c2fe2f4e), gated on CTO approval.

#### 3. Site restoration (DONE)

- ✅ voyonder.com restored ~06:37 UTC by founder (Ben)
- ✅ Root cause: zombie docker-proxy PID 3951678 holding 127.0.0.1:3000 after `docker compose --force-recreate`
- ✅ Fix: kill zombie process, restart travel_app container
- ✅ Guardrail: uptime monitoring cron every 60s checking /api/health/live
- ✅ Follow-ups: VOY-1481 (harden recovery) and VOY-1482 (deeper root-cause) in backlog

### Deployment Pipeline Note

The GitHub Actions deploy to VPS-1 has intermittent SSH connectivity failures (broken pipe). This is a pre-existing infrastructure issue. If the deploy pipeline fails again:

```bash
# Manual deploy from local machine with SSH access
docker build --platform linux/amd64 -t travel_app:latest -f Dockerfile .
docker save travel_app:latest -o /tmp/travel_app.tar
scp /tmp/travel_app.tar root@vps-1.adoptaitech.com:/tmp/
ssh root@vps-1.adoptaitech.com
cd /opt/travel_planner
docker load -i /tmp/travel_app.tar
docker compose -f docker-compose.production.yml up -d --force-recreate
```

### Gates

| # | Gate | Owner | Status | Action Needed |
|---|---|---|---|---|
| 1 | ⚠️ voyonder.com P0 outage | Founder (Ben) | ✅ **RESOLVED** (~06:37 UTC) | Root cause: zombie docker-proxy. Uptime monitoring installed. Follow-ups in backlog. |
| 2 | ✅ Plan scope approval | **APPROVED** (Ben, 05:19 UTC) | ✅ Done | All 3 request_confirmations accepted |
| 3 | Discord link deploy | Founding Engineer | ⏳ **TODO** | VOY-1489 — re-run GitHub Actions deploy or manual deploy on VPS-1 (CEO wake comment posted) |
| 4 | Case studies CTO approval | CTO | ⏳ **PENDING** | VOY-1477 — accept request_confirmation 9c27e7d8, then Staff Engineer review, then FE merges PR #6 + deploys |
| 5 | GitHub Actions SSH key | Founder (Ben) | ❓ UNKNOWN | If VPS_SSH_KEY is expired/broken, manual deploy is the fallback |
| 6 | Case studies content direction | Founder (Ben) | ⏳ **PENDING** | Real customer stories for later iteration; draft content ships now (VOY-1477 note) |

### Disposition

**Plan is complete and approved (v4 accepted by founder). Release is NOT yet complete because both deliverables are not live on voyonder.com.**

**Remaining work (delegated to children):**
1. **VOY-1489** — Re-run GitHub Actions deploy for Discord link (commit c4b895b on main, CI passed, deploy failed). FE woken with instructions.
2. **VOY-1477** — Get CTO to accept request_confirmation 9c27e7d8 → Staff Engineer review PR #6 → merge → deploy → verify `/case-studies/` live.

**Parent (VOY-1413)**: in_progress — children own the next steps with clear assignees (both → Founding Engineer). Parent switched from blocked/planning to in_progress/standard in heartbeat ~07:35 UTC. Once both deliverables are confirmed live, VOY-1413 can be marked done.

**CEO wake notifications dispatched this heartbeat:**
- ✅ VOY-1489 (Discord deploy) — FE woken with deploy instructions
- ✅ VOY-1477 (case studies) — FE woken, priority raised, CTO gate documented
- ✅ VOY-1490 (duplicate) — cancelled with explanation

### Non-Goals / Out of Scope (per user steering)

- ❌ Paperclip code changes (paperclip repo)
- ❌ Paperclip documentation deployment (paperclip.mintlify.app, docs.paperclip.ing)
- ❌ Push to fork/master (PraeSynBH/paperclip)
- ❌ Mintlify dashboard connection to GitHub repo
- ❌ Voyonder application feature work (trip planning, billing, etc.)
- ❌ Production app deployment pipeline changes for application features
- ❌ VOY-1481/VOY-1482 (backlog engineering follow-ups, not blocking this release)