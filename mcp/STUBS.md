# MCP Connectors — Inventory

This file enumerates every MCP connector Odysseus knows about, the configuration shape, and whether the official Anthropic MCP server is published.

## Per-connector status

| Connector | Anthropic May-2026 set? | Config file | Status |
|---|---|---|---|
| Google Drive | ✓ | `google-drive.json` | Live (server-gdrive) |
| Gmail | ✓ | `gmail.json` | Live (server-gmail) |
| Slack | ✓ | `slack.json` | Live (server-slack) |
| GitHub | ✓ | `github.json` | Live (server-github) |
| Supabase | – | `supabase.json` | Live (Supabase community server) |
| DocuSign | ✓ | `docusign.json` | MCP shape documented; v1 uses direct REST |
| Ironclad | ✓ | `ironclad.json` | MCP shape documented; v1 uses direct REST |
| iManage | ✓ | `imanage.json` | MCP shape documented; v1 uses direct REST |
| NetDocuments | ✓ | `netdocuments.json` | MCP shape documented; v1 uses direct REST |
| Box | ✓ | `box.json` | MCP shape documented; v1 uses direct REST |
| Outlook (M365) | ✓ | `outlook.json` | MS Graph direct |
| Jira | – | `jira.json` | direct REST |
| Westlaw / CoCounsel | ✓ | `westlaw.json` | direct REST until official MCP lands |
| Lexis | ✓ | `lexis.json` | direct REST |
| Relativity | ✓ | `relativity.json` | direct REST |
| Everlaw | ✓ | `everlaw.json` | direct REST |
| Definely | ✓ | `definely.json` | direct REST; primarily Word-side |
| Datasite (VDR) | ✓ | `datasite.json` | direct REST |
| Clio | – | `clio.json` | direct REST (custom for small-firm billing) |

## Anthropic May-2026 connectors not yet wired

These are listed in the Anthropic legal blog announcement but not yet given a JSON config in `mcp/`. Add as needed:

- **Consilio** — e-discovery managed services.
- **Midpage** — legal research.
- **Trellis** — court data / litigation analytics.
- **Harvey** — AI legal co-pilot (typically used as a peer system, not a connector — under review whether it should be an MCP or a separate runtime).
- **Solve Intelligence** — patent prosecution support.
- **BoardWise** — board governance.
- **Courtroom5** — civil litigant self-help (UPL-sensitive; would only be enabled in legal-clinic profile).
- **Descrybe** — legal AI search.
- **Free Law Project / CourtListener** — open court data.
- **Legal Data Hunter** — legal data acquisition.

## Adding a new connector

1. Create `mcp/<name>.json` with the standard shape (name, display_name, transport, env_required, enabled_in_profiles, privilege_ring_default, actions_gated, notes).
2. Add required secrets to `profiles/<profile>.yaml::required_secrets` for any profile that enables it.
3. If the connector requires a custom MCP server, add the server spec under `mcp/servers/<name>/` (post-v1 — v1 uses direct-REST adapters in the forked server).
4. Update this STUBS.md row.

## Privilege ring defaults

Every connector sets a default `privilege_ring`. The Privileged-Disclosure risk gate uses this to block cross-ring leaks:
- `attorney-client` — DMS, billing, matters store, M365 mail. (Strictest.)
- `work-product` — e-discovery, VDR. (Strict, litigation-shaped.)
- `confidential` — chat (Slack), tickets (Jira), code (GitHub), research (Westlaw / Lexis).
- `none` — public-facing only (no v1 connector defaults here).

A workspace operator can upgrade a ring (never downgrade) for specific channels/folders/projects in workspace config.
