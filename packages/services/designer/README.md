# designer

MCP + CLI that lets your coding agent drive **[claude.ai/design](https://claude.ai/design)** (Claude's wireframe + hi-fi design tool, no API) with full context of your codebase — capabilities, data shape, existing tokens fed into every prompt.

Human describes intent → agent surveys codebase and prompts Claude Design → hands you the URL → iterate → `designer_handoff` bundles the result (README + chats + HTML + JSX) back into your repo.

> **Status:** v0.3.0, early. macOS only.

## Stance

- **Single-vendor, single-purpose.** Only `claude.ai/design`.
- **Real Chrome via CDP.** Sidesteps Cloudflare + Google SSO.
- **Capabilities drive design.** Agent surveys the codebase (entities, operations, states, tokens) and feeds them into every prompt. Intent tells Claude Design *how*; the codebase tells it *what*. See the [designer-loop skill](skills/designer-loop/SKILL.md).
- **URL is the default taste path.** `designer_prompt` returns a live claude.ai/design URL with working tweak sliders and variant switcher.
- **Artifacts land on disk.** Every iteration + handoff saves under `./artifacts/{key}/`.

## Install

### Prerequisites

- macOS, Node 20+, Google Chrome at `/Applications/Google Chrome.app`.
- `agent-browser` on PATH: `npm i -g agent-browser` (or `brew install agent-browser`).

### Three paths

All land at `designer setup`.

```bash
# A. Trial — no install
npx -y @pro-vi/designer setup

# B. Daily use
npm i -g @pro-vi/designer && designer setup

# C. Hacking on it
git clone https://github.com/pro-vi/designer.git && cd designer
npm install && ./bin/designer setup
```

### What `designer setup` does

1. Verify deps (lockfile-hash compare).
2. Check `agent-browser` on PATH.
3. Ask you to quit a non-debug Chrome (polls until done).
4. Launch debug Chrome (`--remote-debugging-port=9222`, profile at `~/.chrome-designer-profile/`).
5. Poll until you sign in and land on `/design`.
6. Install the `designer-loop` skill at `~/.claude/skills/designer-loop/` (skipped if already present — respects dotfile symlinks).
7. Register the MCP with Claude Code (user scope).

Re-run anytime — idempotent. Verify with `designer doctor`.

### MCP only (skip the CLI)

```bash
claude mcp add --scope user --transport stdio designer \
  -- env DESIGNER_CDP=9222 npx -y @pro-vi/designer mcp serve
```

Still needs debug Chrome running (`npx -y @pro-vi/designer setup` handles it).

### Notes

- **Dedicated profile.** Chrome 136+ blocks `--remote-debugging-port` on the default profile. Login to `~/.chrome-designer-profile/` persists.
- **Auto-launch.** MCP auto-launches debug Chrome on the first tool call if the profile exists.
- **Bot detection.** Real Chrome + user-controlled login — not headless. Cloudflare + Google OAuth see a normal session. First login may trigger a Google new-device prompt.
- **`DESIGNER_CDP=9222`** is embedded in the MCP registration. Only export it in your shell if you invoke the CLI directly.

## CLI

```
designer setup                                       (once per machine)
designer session --action create --name "X" --key x  start a project
designer prompt "design the …" --key x               prints 'Taste here: <url>'
designer prompt - --key x < follow-up.txt            iterate
designer handoff --key x                             bundle for code implementation
```

Every verb has `--help`. `--key <k>` isolates parallel sessions (state at `~/.designer/sessions.json`). Prompts accept positional, `--prompt-file`, or stdin (`-`).

## MCP

Six tools, registered at user scope by `designer setup`:

| Tool | Purpose |
|---|---|
| `designer_session` | Enter / inspect / transition. Returns stored state + `currentUrl` + `availableFiles`. |
| `designer_prompt` | Modify the design (HTML-diff wait). Returns `url`, `newFiles`, `activeFile`, `failureMode`, `htmlPath`, `chatReply`. |
| `designer_ask` | Q&A with the assistant, no file changes. |
| `designer_list` | `projects` or `files` (flat-only — see quirks). |
| `designer_snapshot` | Capture current file. Paths + hash by default; `includeHtml: true` inlines. |
| `designer_handoff` | Export → download + extract tar.gz. Auto-repairs em-dash filename bugs. |

## The loop

```
1. Intent       → human describes what they want to feel / change
2. Survey       → agent reads the target repo: entities, operations, states,
                  failure modes, existing tokens — capability facts, verbatim
3. Relay        → designer_prompt = intent + capabilities, minimal faithful prompt
4. Taste        → hand the human the returned URL; they react in their own words
5. Interpret    → next designer_prompt (modify) or designer_ask (clarify)
6. Repeat 3-5   → until human says "that's it"
7. Promote      → designer_handoff — bundle is the decision record
```

Full guidance in [`skills/designer-loop/SKILL.md`](skills/designer-loop/SKILL.md).

## Tasting harness

Fallback when the live URL's IDE chrome eats viewport. Requires a prior handoff.

```bash
designer tasting --key <key>
```

Writes `tasting.html` with variant tabs + 1/2/3 shortcuts + persistent notes, serves locally, opens the browser.

## Operations

- `designer doctor` — diagnose setup state. Exits 2 on failure.
- `designer health [--json]` — probe 17 UI anchors. Wire into cron to catch claude.ai UI regressions.
- **Daily CI** in `.github/workflows/`: `daily-health.yml` runs the auth-required UI probe on a self-hosted macOS runner once per day; `ci.yml` typechecks + builds + does a Docker clean-room install smoke on every PR; `release-please.yml` opens a release PR on conventional commits, merging it tags + publishes via `release-publish.yml`. Selector regressions land as auto-opened PRs under the `selectors-drift` label.

## Known quirks

- **Folder-organized variants.** The live file-list scrape is flat-only; nested files invisible until `designer_handoff`. `designer_prompt` auto-appends *"no subfolders."* Bundle + `designer tasting` are folder-aware.
- **React-controlled inputs.** `agent-browser fill` doesn't fire React's synthetic `input` event; we use the native value-setter + `dispatchEvent` + JS `.click()`.
- **Em-dash handoff filenames.** Claude's handoff pipeline sometimes writes `—` in hrefs but `-` in filenames. `designer_handoff` detects and repairs.
- **UI regressions.** Claude has moved critical buttons mid-development (Export → Share). Run `designer health` periodically.

## Credits

Built on [`agent-browser`](https://github.com/ctate/agent-browser) by [@ctatedev](https://x.com/ctatedev).

## License

[MIT](LICENSE).
