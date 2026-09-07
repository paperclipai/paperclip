# CLI how-to (nomandyOS)

Workspace: `/Users/jcafeitosa/Development/nomandyOS`
Project board: `nomandyos` · Board URL service: `http://127.0.0.1:47823`
Always pass `--thread-id <agent-or-carlos-orchestrator>` on mutating taskctl.

## 1. taskctl (Taskboard)
```bash
taskctl context current --cwd /Users/jcafeitosa/Development/nomandyOS --json
taskctl issue list --project nomandyos --json
taskctl issue get NOM-N --json
taskctl issue create --project nomandyos --title "..." --status todo --labels type:task,level-a --thread-id carlos-orchestrator --json
taskctl issue move NOM-N --status in_progress --if-version N --thread-id carlos-orchestrator --json
taskctl comment add <task-uuid-or-NOM> --body "..." --thread-id carlos-orchestrator --json
```
Subcommands: project list/create/map · issue list/get/create/update/move/archive/restore/relation · comment list/add/update/delete · attachment · context current · cloud login/status/logout

## 2. ok (OpenKnowledge)
```bash
ok -h
ok status
ok start          # UI+API+MCP on one port (do NOT run bare `ok` in agent shells — it blocks)
ok stop
ok lint knowledge/
ok audit
ok sync           # commit/pull/push when sharing
ok mcp            # stdio MCP for editors
```
Vault: `knowledge/`. Bare `ok` launches desktop/server and hangs — agents use subcommands.

## 3. gh / git (GitHub MCP down)
```bash
gh auth status
gh pr list --repo paperclipai/paperclip --state open
gh pr checks <n>
gh pr view <n> --json number,title,state,headRefName,statusCheckRollup
git status && git rev-parse --short HEAD
```

## 4. bun
```bash
bun --version
bun install
bun test
bun run <script>
```

## 5. Coding agents / ACP
- Installed: `claude`, `codex` (Homebrew). NOT installed globally: `acpx`, `gemini`, `goose`, `copilot`.
- Headless ACP client (on demand): `npx acpx@latest --help` works.
- Claude agent-friendly: `claude -p "...\" --output-format text` (non-interactive).
- Codex: `codex exec "...\"` or `codex mcp-server` / `codex app-server` (experimental; not native `--acp` flag in help).
- Native ACP agents typically: Gemini CLI `--acp`, Copilot CLI ACP preview — **not on this Mac PATH**.

## Agents (Grok Bot) can use?
Yes, via Shell on the Mac (`machineId`) after local-tool approval. Prefer CLI-first (NOM-14). Do not start long-lived `ok` / interactive TUI from agents without `block_until_ms 0` + explicit stop.

Board: NOM-14. Skill: nomandyos-agent-resources.
