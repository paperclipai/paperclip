# `doc/` — Internal Engineering Documentation

**Charter:** deep design specs, RFC-style plans, and experiments for people
working *on* Paperclip.

This is **not** the user-facing documentation. Anything an operator,
agent-developer, or deployer reads lives in [`../docs/`](../docs) (the published,
Mintlify-rendered source of truth). A doc in `doc/` must **never re-explain a
user-facing concept** — link to the `docs/` page instead.

> The model to copy: [`DEPLOYMENT-MODES.md`](./DEPLOYMENT-MODES.md) holds the
> canonical design (and is cited as canonical by `PRODUCT.md`, `CLI.md`,
> `DEVELOPING.md`, `SPEC-implementation.md`); the user-facing summary lives at
> [`../docs/deploy/deployment-modes.md`](../docs/deploy/deployment-modes.md).
> Internal design + user summary, cross-linked. Do that, don't duplicate.

## What lives here

| Area | Files / dirs |
|------|--------------|
| Vision & product | `GOAL.md`, `PRODUCT.md` |
| Core specs | `SPEC.md`, `SPEC-implementation.md`, `TASKS.md`, `TASKS-mcp.md`, `execution-semantics.md`, [`spec/`](./spec) |
| Subsystems | `DATABASE.md`, `CLI.md`, `CLIPHUB.md`, `AGENT-ARTIFACTS.md`, `memory-landscape.md` |
| Deploy & ops | `DEPLOYMENT-MODES.md`, `DOCKER.md`, `SECRETS-AWS-PROVIDER.md`, `LOW-TRUST-PRESETS.md`, `RELEASING.md`, `PUBLISHING.md`, `RELEASE-AUTOMATION-SETUP.md` |
| Security / process | `UNTRUSTED-PR-REVIEW.md`, `OPENCLAW_ONBOARDING.md`, `DEVELOPING.md` |
| Plugins | [`plugins/`](./plugins) — `PLUGIN_SPEC.md`, `PLUGIN_AUTHORING_GUIDE.md`, … |
| Design log | [`plans/`](./plans) — see `plans/README.md` |
| Other | [`experimental/`](./experimental), [`logs/`](./logs), [`pr/`](./pr), [`assets/`](./assets), [`screenshots/`](./screenshots) |

## Rules for adding to `doc/`

1. **No user-facing prose.** If a board operator or deployer would read it, it
   belongs in `docs/`. Put only the internal/design depth here and link out.
2. **No duplication across the two roots.** One concept, one home. If both an
   internal and a user view are needed, split them and cross-link (see the
   deployment-modes model above).
3. **Dated plans are an append-only log**, not living docs — see
   [`plans/README.md`](./plans/README.md).
