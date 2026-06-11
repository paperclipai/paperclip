# AGNB — All Gas No Brakes

**Your growth team, now autonomous.**

AGNB is an autonomous agent-company SaaS. Founders and marketers spin up an AI
company — a CEO/CMO/CFO plus producer agents (Blog Writer, Sales-Ops, SEO
Analyst, Reviews Monitor) — all driving one North Star growth goal.

- **Live:** https://allgasnobrakes.online · docs at `/docs`
- **Stack:** Express + Drizzle (Postgres) `server/` · React + Vite `ui/` · pnpm monorepo · Google Cloud Run

---

## Built on Paperclip (and what we added)

AGNB is built on top of [Paperclip](https://github.com/paperclipai/paperclip),
an open-source AI-agent orchestration platform (MIT). Paperclip gives us the
control-plane primitives — org charts, heartbeat execution, budgets,
governance, multi-company isolation, plugins. We deliberately keep upstream's
package namespaces (`@paperclipai/*`), env prefixes (`PAPERCLIP_*`), and
internal identifiers **unchanged** so we can keep merging upstream improvements
with a small conflict surface. See [`NOTICE`](NOTICE) for attribution.

**The AGNB layer is ours** — everything below is built on top, not forked into:

| Area | Where | What |
|------|-------|------|
| **AGNB vertical** | `server/src/agnb/` | The autonomous agent-company product: ~35-job scheduler, agent roster (CEO/CMO/CFO + producers), `/api/agnb/*` routes, North Star goal model. |
| **Pitch-deck generator** | `server/src/agnb/pitch/`, `ui/src/pages/Pitch*` | Intake form → Claude-generated reveal.js deck → stored + previewed. Clean 16:9 PDF export (headless-Chrome screenshots). Assets on a public GCS bucket. |
| **Marketing site & landing** | `ui/src/` (landing, StoryRail) | The allgasnobrakes.online front door — story rail, brand, copy. |
| **Custom-domain infra** | HTTPS LB + hostname allowlist | `allgasnobrakes.online` on Cloud Run behind a managed cert. |
| **Rebrand** | marketing/docs/app chrome | All user-facing surfaces are AGNB; Paperclip plumbing stays internal. |
| **Authz extensions** | `server/src/services/authorization.ts` | Company-member workspace visibility and related policy changes. |

A full engineering handoff (architecture, gotchas, deploy) lives in
[`AGNB_HANDOFF.md`](AGNB_HANDOFF.md) — **read it first.**

---

## Quickstart (local dev)

```bash
pnpm install
HEARTBEAT_SCHEDULER_ENABLED=false pnpm dev
```

This starts the API at `http://localhost:3100` with an embedded Postgres (no
setup). Vite serves the UI at `:5173` and proxies `/api` → server.

> **Keep `HEARTBEAT_SCHEDULER_ENABLED=false` locally.** Otherwise local
> schedulers wake and hit the **production** DB (8–30s latency). Run **one**
> dev server — no duplicate `pnpm dev`.

> **Requirements:** Node.js 20+, pnpm 9.15+

### Common commands

```bash
pnpm dev              # API + UI, watch mode
pnpm dev:server       # Server only
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test             # Vitest run
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

---

## Deploy

Manual, ~10–12 min, to Cloud Run (`asia-south1`, project
`gen-lang-client-0289669375`, service `paperclip`):

```bash
gcloud run deploy paperclip --source . --region asia-south1 --project gen-lang-client-0289669375
```

`--source` preserves env/secrets — don't re-pass them. Verify the new revision
and `curl https://allgasnobrakes.online/` after. See `AGNB_HANDOFF.md` for the
full deploy + custom-domain details.

---

## Upstream

We track upstream Paperclip via the `upstream` git remote and re-merge every
1–2 weeks to keep the conflict surface small. Principle on conflicts: **take
upstream code/logic, keep AGNB branding.**

```bash
git remote -v          # origin = our repo, upstream = paperclipai/paperclip
git fetch upstream
git merge upstream/master
```

---

## License

AGNB application code © 2026 the AGNB authors.
Built on Paperclip, MIT © Paperclip Labs, Inc. Full terms in [`LICENSE`](LICENSE)
and attribution in [`NOTICE`](NOTICE).
