# `docs/` — User-Facing Documentation (Source of Truth)

**Charter:** the published, Mintlify-rendered documentation. This is the
**single source of truth** for anything an operator, agent-developer, or
deployer reads.

Navigation and rendering are driven by [`docs.json`](./docs.json) — a new page
only appears on the published site once it is added there.

Internal design specs, RFC-style plans, and experiments do **not** live here —
they live in [`../doc/`](../doc). When a user-facing page needs deeper internal
context, link to the matching `doc/` page rather than copying it in.

> This file is a contributor note and is intentionally **not** registered in
> `docs.json`, so it does not appear on the published site.

## Layout

| Section | Audience |
|---------|----------|
| [`start/`](./start) | Product overview, quickstart, core concepts, architecture |
| [`api/`](./api) | REST API reference |
| [`cli/`](./cli) | CLI commands |
| [`deploy/`](./deploy) | Local, Docker, AWS ECS, env vars, secrets, storage |
| [`guides/board-operator/`](./guides/board-operator) | Running companies, agents, tasks, costs, approvals |
| [`guides/agent-developer/`](./guides/agent-developer) | Heartbeat protocol, task workflow, skill authoring |
| [`adapters/`](./adapters) | Per-provider adapter setup + authoring |
| [`companies/`](./companies) | Multi-company data model |
| [`specs/`](./specs) | Strategic feature specs |

## Rules for adding to `docs/`

1. **Register new pages in `docs.json`** or they will not publish.
2. **One concept, one home.** Do not restate internal design that lives in
   `doc/`; link to it. See the `deployment-modes` pair (`docs/deploy/` +
   `doc/DEPLOYMENT-MODES.md`) for the intended split.
3. **User-facing voice.** If the content is only meaningful to someone editing
   Paperclip's source, it belongs in `doc/`.
