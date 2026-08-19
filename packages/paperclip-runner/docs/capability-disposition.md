# Capability Capability Disposition

This page explains how Capability classifies every Paperclip capability. The
classification itself lives in a generated file,
[the Capability contract](capability-contract.md), which
carries a "DO NOT EDIT" header and is rewritten by `generate:capability-inventory`.
Read this page to understand what the generated table means; read the table for
the authoritative rows.

## Normative sources

Only two sources are normative:

1. The Paperclip skill and its seven references (`SKILL.md` plus
   `references/*.md`), contributing **152 headings**.
2. The Paperclip Evals corpus, contributing **106 cases across 16 groups**.

Together these produce **258 normative rows**. The legacy Paperclip MCP tool
surface (**41 tools**) is not a production capability surface; each MCP name is
folded one-to-one into a normative eval row as a traceability alias and inherits
that row's disposition. The contract prints the alias index only so the
normative target is easy to audit.

## The three dispositions

Every capability is classified as exactly one of:

- **`control_plane_owned`** — the control plane performs this; no agent tool
  exists for it. Checkout, inbox resolution, blocker diagnostics, and status
  arbitration are control-plane-owned. In the explorer these appear as
  control-plane actions labelled "no agent tool exists for this," never as a
  callable tool.
- **`always_agent_tool`** — the agent always has this as a semantic tool. Adding
  a comment, writing a document, opening an interaction, and registering a
  deliverable are always-agent-tool capabilities.
- **`optional_agent_tool`** — the agent may have this tool, but only when a
  grant unlocks it. Absent the grant, the capability is not exposed and calling
  it is denied. See [authorization and exposure](capability-authorization-and-exposure.md).

The disposition is what makes the boundary legible: it states, per capability,
whether an agent can act, must wait for the control plane, or needs a grant
first.

## Reading the generated contract

The contract has three parts:

- **Baseline counts** — the heading, case, row, and alias totals above, plus the
  per-group case table.
- **Skill / reference rows** — one row per heading, its primary disposition, and
  its `file:line` source anchor.
- **Legacy MCP alias index** — each MCP name, the normative row it folds into,
  the inherited disposition, and its `packages/mcp-server/src/tools.ts` anchor.

## Regenerating and checking

Generation reads the live in-repo skill/reference sources, the legacy MCP tool
source, and the Paperclip Evals corpus, so it **requires** the external eval
repository (via `PAPERCLIP_EVALS_ROOT` or a known local path) and is not part of
the offline path. Checking and testing read only the checked-in derivatives
under `spec/capability/` and need no external repository.

```sh
# Rewrite every generated file. Requires the external Paperclip Evals corpus.
pnpm --filter @paperclipai/paperclip-runner generate:capability-inventory

# Validate counts, uniqueness, normative dispositions, one-to-one MCP folds,
# required fields, and generated-file drift. Offline; no external eval repo.
pnpm --filter @paperclipai/paperclip-runner check:capability-inventory

# Prove the validator rejects an independent MCP classification and rejects
# missing, duplicate, or unknown MCP folds. Offline.
pnpm --filter @paperclipai/paperclip-runner test:capability-inventory
```

`check:capability-inventory` diffs the checked-in generated files against what the
live in-repo sources imply and fails on any drift or stale anchor, so the
contract cannot silently fall out of sync.

## Related

- [Semantic tool catalog](capability-semantic-tools.md)
- [Authorization and exposure](capability-authorization-and-exposure.md)
- [Eval conformance](capability-eval-conformance.md)
