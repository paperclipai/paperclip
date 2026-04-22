---
type: concept
title: Workshop initial setup decisions
tags: [workshop, architecture, decisions, hour-1]
---

# Workshop Initial Setup — Decision Log

Hour 1 (2026-04-22). Decisions made while forking Paperclip AI into `github.com/jkrums/workshop`. Record the *why* so future sessions don't re-litigate.

## Why fork Paperclip at all

Janis needs a **control plane** — a persistent place that holds agent identity, issues, runs, approvals, and routines across multiple companies (Lobbi today, Lobbi Card Q4 2026, personal projects). Paperclip already implements Company → Agent → Issue → Run → Routine → Approval as first-class primitives, on embedded Postgres, with MCP + REST + a decent UI. MIT license. Building this from scratch would be weeks. Forking is hours.

**Alternative rejected:** Using Paperclip as a hosted service. Loses customization, adds external dependency on a small project, and the whole point is that this is Janis's *operating system*, not a SaaS relationship.

## Why fork to personal account (jkrums/workshop) not org

Workshop is personal infrastructure that happens to orchestrate company work. Lobbi the company has its own repos (`Lobbi-Group/lobbi`, `Lobbi-Group/card-*`). Workshop coordinates across companies Janis operates — mixing it into the Lobbi org would make it awkward when the second company comes online.

## Why "Workshop" as the name

Internal brand only. Evokes a place where an operator builds, not a product to sell. Paperclip is the upstream name we merge from; Workshop is what we call our fork.

## Why shallow rebrand, not deep

**Shallow:** UI strings ("Paperclip" → "Workshop" in page titles, headers, sidebar). User-visible only.
**Deep:** Package names (`@paperclipai/*`), env vars (`PAPERCLIP_API_KEY`), home dir (`~/.paperclip/`), database schema names.

We are doing shallow only. Deep rebrand breaks `git pull upstream master` — every merge becomes a manual reconciliation of renamed files. Paperclip is active upstream; we want security patches and new adapters for free. The cost of seeing "paperclip" in a process list or env var is near-zero; the cost of stuck-on-fork is high.

Revisit if upstream goes dormant or our diff grows past ~30% of surface area.

## Why user-scope MCP, not local-scope

Claude Code's default MCP scope (`local`) binds a server to one project directory. We want Paperclip tools available from **every** Conductor workspace (rabat, perth, albany, future). User scope (`-s user`) installs once per machine and exposes the server everywhere. First install used local scope by mistake; fixed by removing and reinstalling with `-s user`.

## Why Workshop is control plane, not monorepo

Janis asked: "should all products live inside Workshop?" Answer: No.

- **Workshop** owns: agent identity, routines, approvals, audit logs, cross-company coordination.
- **Products** (Lobbi app, Lobbi Card services, personal tools) own: their own code, deploys, schemas, teams.

Analogy: Workshop is a factory control room. The machines on the floor (products) each have their own enclosures. The control room watches them, schedules them, tells them when to run — but the machines aren't *inside* the control room.

This matters because product repos have their own CI, deploys, dependency cycles, team access policies. Forcing all that into one monorepo creates coupling we don't want and doesn't solve a problem we have.

## Hour 1 end state

- Fork: `github.com/jkrums/workshop` (master tracks `paperclip-ai/paperclip`)
- Local server: http://localhost:3100 — UI boots, auth works
- Embedded Postgres: `~/.paperclip/instances/default/db` on port 54330
- Agent JWT secret: persisted at `~/.paperclip/instances/default/.env` (chmod 600, NOT in git)
- Company: Lobbi — UUID `5f8e4374-e127-4173-95cc-1125a73b5e6d`
- Agent: Hermes (claude-code adapter) — UUID `5a115338-72dd-4b7b-b1bf-b996937d1325`
- Smoke test issue (LOB-1): passed. Hermes checked out, ran, closed.
- MCP: paperclip server registered at user scope, reads API key from env

## Upstream merge policy

- `master` branch on `jkrums/workshop` tracks `paperclip-ai/paperclip` master. Merge upstream weekly.
- Our work lives on feature branches (`feat/workshop-bootstrap`, etc.) merged into `master` via PR like normal.
- If an upstream change conflicts with our shallow rebrand, resolve in favor of upstream — rebrand is a thin veneer we re-apply as needed.
