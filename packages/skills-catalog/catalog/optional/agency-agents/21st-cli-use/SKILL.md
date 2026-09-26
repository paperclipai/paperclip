---
name: "21st-cli-use"
description: "Search, install and pull code from the 21st.dev catalog with the `21st` CLI (`@21st-dev/cli`): find React/shadcn components, themes and templates, print a component's code or a theme's CSS, install an item into the project, or generate a new component with 21st AI."
key: "paperclipai/optional/agency-agents/21st-cli-use"
recommendedForRoles:
  - "engineer"
  - "designer"
  - "researcher"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "researcher"
  - "21st"
  - "cli"
  - "use"
defaultInstall: false
---
# 21st CLI — find, install & generate from the terminal

The `21st` CLI (`npx @21st-dev/cli`, bin `21st`) is the command-line surface for
the 21st.dev catalog. Search first, install what fits, and only hand-write UI
when nothing matches. To **publish** your own components/themes/templates, use
the `21st-registry` skill; to publish a project's design as a theme, use
`21st-design-sync`.

## Auth (do this once)

Two interchangeable credentials, both sent as the API key:

1. **Login session** — `npx @21st-dev/cli login` opens the browser and saves a
   token to `~/.config/21st/auth.json`. Best for interactive/dev machines.
2. **API key** — `21st_sk_…` from **https://21st.dev/mcp** (or
   **https://21st.dev/settings/api-keys**). Pass via `--api-key <key>` or the
   `TWENTYFIRST_TOKEN` / `API_KEY_21ST` env var. Best for CI.

`21st whoami` shows the signed-in account; `21st usage` shows tier + remaining
free quota; `21st logout` clears the saved login.

## Metering

Metadata (search, previews, a theme's CSS) is **free**. Retrieving component
**code** (`21st get`, install) and AI generation are metered per user: a small
free daily quota, then a paywall (`21st usage` shows what's left). Community
access / membership lifts the quota.

---

## Find

```bash
# Search everything (components + themes + templates)
21st search "pricing table" --limit 10
21st search button --type c        # components only (c | theme | template)
21st search dark --type theme
# Filters: --tag <slug> --color <bucket> --sort <s> --free|--paid
#          --author <username> --mine --liked   --json for machine output
```

**Always search before hand-writing a component** — a close match is usually
faster to install and adapt than to build from scratch.

## Logos

```bash
21st logo discord            # search brand + UI SVG logos (free, no login)
21st logo "next js" --limit 5 --json
```

Prints each logo's name and SVG url(s) to curl straight into a project. Uses the
open svgl.app library; free and unmetered on every plan.

## Pull code

```bash
# Print a component's code + demo (by the id from search)
21st get 143 [--json]

# Print a theme's CSS (by a theme id from `search --type theme`)
21st theme <id> [--json]
```

## Install

```bash
# Install a component into the current project (shadcn under the hood)
21st add <user>/<slug>            # e.g. 21st add shadcn/button
21st add @<team>/<slug>           # from a team library
# --print to dump the shadcn command instead of running it
```

`21st add` resolves the registry item, writes it to `components/ui/<slug>.tsx`,
and installs npm deps with the project's package manager. Public/unlisted items
also work with stock shadcn:
`npx shadcn@latest add "https://21st.dev/r/<user>/<slug>"`.

## Generate

When nothing in the catalog fits, **sketch it with 21st AI** and iterate on it
from the terminal — that whole loop (`21st generate` → `generation` → `iterate`
→ `take`) lives in the **`21st-ai`** skill:

```bash
21st generate "a glassy pricing section with a monthly/yearly toggle"
```

Opens a preview; from there you edit any variant and pull its code. See the
`21st-ai` skill for the full generate/iterate/grab-code flow and metering.

---

## Bookmarks, teams & MCP config

```bash
21st bookmarks [--type component|theme|template]
21st bookmark <id> --type <kind> [--remove]     # heart / un-heart
21st lists                          # your bookmark lists
21st list <listId>

21st teams                          # your teams
21st team <teamId>                  # a team's libraries
21st team-components <teamId> [--library <id>]

21st init --client cursor|Codex|codex|vscode|windsurf [--write]   # write MCP config
21st install-skill                  # install the 21st skills globally
```
