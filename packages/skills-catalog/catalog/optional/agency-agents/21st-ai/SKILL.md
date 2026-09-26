---
name: "21st-ai"
description: "Generate and iterate on UI with 21st AI from the terminal via the `21st` CLI (`@21st-dev/cli`): sketch a UI from a prompt, preview the variants in the browser, edit any variant in place with a natural-language change, and pull the final code into the project."
key: "paperclipai/optional/agency-agents/21st-ai"
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
defaultInstall: false
---
# 21st AI — sketch, iterate & grab code from the terminal

21st AI is a fast UI-drafting board. Mental model: **draft it here, then finish
it** — sketch a few variants from a prompt, preview them, refine the one you like
with plain-English edits, and pull its code into the repo. The whole loop runs
from the `21st` CLI (or the matching MCP tools), so you never leave the editor.

Sketch mode produces self-contained **HTML + Tailwind** drafts (fast, no build).
The recommended handoff is the **copy-prompt**: a spec that tells you to rebuild
the design in the target project's real stack — not paste raw HTML verbatim.

## Auth

Same credential as the rest of the CLI: `21st login` (saved token) or a
`21st_sk_` key via `--api-key` / `TWENTYFIRST_TOKEN`. `21st usage` shows tier +
remaining quota. (See the `21st-cli-use` skill for the full auth notes.)

## The loop

```bash
# 1) Sketch — generate variants ("takes") from a prompt. Opens the preview in
#    the browser and prints the projectId.
21st generate "a pricing section with 3 tiers and a monthly/annual toggle"

# 2) List the takes (1-based numbers + whether each has rendered yet).
21st generation <projectId>

# 3) Edit ONE take in place with a natural-language change (PAID — see Metering).
21st iterate <projectId> "make it enterprise-flavored, add an annual toggle" --take 3

# 4) Grab the code to bring into the project (FREE).
21st take <projectId> --take 3            # paste-ready copy-prompt (recommended)
21st take <projectId> --take 3 --code     # raw self-contained HTML instead
```

Open the preview URL (printed by `generate`, and returned by `iterate`) in the
editor's built-in browser to watch the variants render and update in place.

## When to use which

- **generate** — start fresh from a prompt. Returns a preview URL + projectId.
- **generation** — list the takes so you know which `--take N` to act on.
- **iterate** — refine an EXISTING take (edited in place; a new version is
  appended, so you can step back in the workspace). Use this to change something
  already generated instead of starting over.
- **take** — pull a take's code. Default prints the copy-prompt (adapt-to-my-
  stack spec); `--code` prints the raw HTML. Both FREE and unlimited.

## Metering

- **generate** — small free daily bucket, then a paywall (`21st usage` shows
  what's left). Community access / membership lifts it.
- **iterate** — billed by real token cost per edit (the shared 21st AI credit
  pool); it does real model work each call, so batch changes into one clear
  instruction rather than many tiny ones.
- **generation** (listing) and **take** (grabbing code) are **FREE**.

## MCP parity

The same loop is exposed as MCP tools for MCP hosts (Cursor, Codex Desktop,
Codex): `generate` (with `mode: "sketch"`), `get_generation`,
`iterate_generation` and `get_take`. `iterate_generation` also returns the
freshly-edited `html` + `copyPrompt`, so you can grab the code without a second
call. Wire up the server with `21st init --client <name> --write`.

## Tips

- A sketch is a **draft, not production code** — treat the copy-prompt as a
  design spec and rebuild it in the project's real components; don't paste the
  HTML as-is.
- Refer to takes by the 1-based number from `generation` / the "Take N" label in
  the preview. `--take` must be a whole number ≥ 1 (a bad value errors rather
  than silently editing take 1).
- Only sketch generations you created can be listed, edited, or fetched.
