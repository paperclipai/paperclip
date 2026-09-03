# Paperclip Startup Template

A reusable, vendor-neutral **agent-company** package that spins up a Paperclip-ready startup with one command. Eight roles, opinionated governance, a strict communication contract, and a forensic-grade logging standard — out of the box.

## What this is

A portable [`agentcompanies/v1`](https://github.com/anthropics/agentcompanies) package containing:

- **8 default roles** wired into a sensible org chart (CEO → CTO → FrontendEngineer / BackendEngineer / Coder / QA / SecurityEngineer; CEO → CMO).
- An **`AGENTS.md`** for every role, with lane boundaries, domain lenses, output bars, safety rules, and handoff contracts.
- The **CEO instruction set** (`AGENTS.md` + `HEARTBEAT.md` + `SOUL.md` + `TOOLS.md`).
- A `docs/` directory with the authoritative governance documents:
  - `docs/rules.md` — heartbeat conventions, AGENTS.md governance template, per-role boundaries, the five non-negotiable communication rules.
  - `docs/teams.md` — org chart, role definitions, capability flags, `desiredSkills` bundles.
  - `docs/logging.md` — heartbeat structure, run audit (`X-Paperclip-Run-Id`), five-section progress comment, status transitions, durable progress evidence.
- A `.paperclip.yaml` manifest so the package imports cleanly into any Paperclip instance.

The template is **vendor-neutral at the package level** (`agentcompanies/v1` works for any agent-company runtime) and **opinionated at the governance level** (Paperclip's heartbeat + audit trail conventions are baked in).

## Who this is for

- **Operators starting a new agent-driven company on Paperclip** and who want a working 8-role baseline instead of authoring eight `AGENTS.md` files from scratch.
- **Operators experimenting with company shapes** (small product team, security-focused org, marketing org) who want a known-good starting point to fork and trim.
- **Anyone evaluating Paperclip's governance model** — the package is human-readable end-to-end; clone it and read the docs to understand how a Paperclip company operates without spinning anything up.

If you are NOT this audience:

- **Importing an existing agent company package** — use Paperclip's normal import flow against your own export; this template is a *starting* point, not a migration tool.
- **Adding a single agent to an existing company** — use the company's `paperclip-create-agent` skill; do not import this template on top of a live company.

## What you get on day one

```
companies/paperclip-startup-template/
  COMPANY.md
  README.md                 # this file
  LICENSE                   # MIT
  .paperclip.yaml           # manifest
  agents/
    ceo/AGENTS.md
    ceo/HEARTBEAT.md
    ceo/SOUL.md
    ceo/TOOLS.md
    cto/AGENTS.md
    cmo/AGENTS.md
    frontendengineer/AGENTS.md
    backendengineer/AGENTS.md
    coder/AGENTS.md
    qa/AGENTS.md
    securityengineer/AGENTS.md
  docs/
    rules.md
    teams.md
    logging.md
```

Eight `AGENTS.md` files, three governance documents, one manifest, one license. No code paths, no product-specific assumptions, no PII.

## How to import

The package is imported with the Paperclip CLI:

```sh
paperclipai company import companies/paperclip-startup-template \
  --target new \
  --new-company-name "<YourCompanyName>" \
  --agents all \
  --yes
```

What this does:

1. Creates a new Paperclip company named `<YourCompanyName>`.
2. Materializes the 8 default agents, each with its `AGENTS.md` and any role-specific instruction files (CEO carries the HEARTBEAT/SOUL/TOOLS triple).
3. Installs the `desiredSkills` bundle for each role (see `docs/teams.md` for the exact bundles). Each skill must already be installed in the destination Paperclip instance's company-skills library — install any missing ones first.
4. Leaves the company ready to take an initial seed goal and start operating.

**Dry run first.** Always preview before committing to a new company:

```sh
paperclipai company import companies/paperclip-startup-template --dry-run
```

The dry run validates the package structure, surfaces any missing skills, and prints what would be created.

## After import: first 30 minutes

1. **Set the seed goal.** Create the first goal that defines the company's purpose (e.g. "Build the X product", "Defensive security posture for the org", "Marketing engine for Y"). Without a seed goal the company has nowhere to point.
2. **Open the first CEO issue.** Assign to the new CEO so the company has a live work item.
3. **Confirm the lane boundaries match your codebase.** If you do not have separate frontend and backend codebases, consider consolidating FrontendEngineer + BackendEngineer into a single Coder before the first hire breaks the lane rules.
4. **Review the capability flags in `docs/teams.md`.** Default-off for most external reach; expand only with a justification trail.
5. **Set adapter type per role.** The template does not pin a specific adapter; coding-heavy roles want a coding-capable adapter, advisory roles are fine on a general one.

## What this template intentionally does NOT carry

- **Product-specific code, schemas, or business logic.** This is a company shell, not a product template.
- **A pre-populated backlog.** The new company starts empty so the operator's first goal defines its direction.
- **Domain-specific skills.** Only the cross-role lifecycle and governance skills ship in the default `desiredSkills` bundles. Add domain skills as the company matures.
- **Identifiers from the originating company.** All issue links, agent UUIDs, and company-specific phrasing have been scrubbed. Governance rules are preserved verbatim; identifiers are not.
- **Operator-specific tooling.** No environment variables, secrets, or external service bindings are encoded in the template.

## Customizing the template

- **Drop a role at import time** — remove the `agents/<slug>/` directory before importing. `docs/teams.md` describes safe removals.
- **Add a role after import** — use the company's `paperclip-create-agent` skill. The template's role list is a starting point, not a contract.
- **Change the governance documents** — fork the package and update `docs/rules.md`, `docs/teams.md`, or `docs/logging.md`. Companies imported from the fork will inherit the changes.
- **Pin to a specific commit** — the package layout is git-friendly. Pin your import to a known-good commit if you operate multiple companies from the same template.

## Attribution

This template was derived from the operating practice of a live Paperclip company and generalized into a reusable seed. Company-specific identifiers were scrubbed; governance rules were preserved verbatim. The package conforms to the [`agentcompanies/v1`](https://github.com/anthropics/agentcompanies) specification, which is vendor-neutral and usable by any agent-company runtime.

## License

MIT. See `LICENSE` in the package root for full terms.

## Reporting issues with the template itself

If you find a gap in the template (a missing handoff, an unclear lane, a `desiredSkills` slug that no longer resolves), open an issue against the template's source repository. Do not patch the template inside an imported company — the change will drift away from the next imported company. Fix the template, then re-import or apply the diff manually to existing companies you want to track.
