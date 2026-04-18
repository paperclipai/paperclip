# ArchonOS End-to-End Test Checklist

## Prerequisites
- Rust toolchain installed (≥1.77)
- Node.js installed (for plugins)
- Claude Code CLI installed (`claude --version` should work)
- ANTHROPIC_API_KEY available

## Test 1: Claude CLI Agent Execution

1. `pnpm tauri dev` — app launches
2. If fresh DB: complete onboarding wizard (company + CEO agent + project + issue)
3. Settings → Secrets → set `ANTHROPIC_API_KEY`
4. Agents → click CEO agent → Configuration tab → click "Test Connection"
   - **Expected:** Green checkmark with Claude version string
5. Click "Wake" button in agent header
6. Click "Runs" tab → see "queued" then "running" status
7. Click the run row → TranscriptViewer expands → stdout streams in
8. Wait for completion → status changes to "succeeded" or "failed"
9. Costs page → shows non-zero spend
10. `sqlite3 ~/Library/Application\ Support/com.archonos.app/archonos.db "SELECT billing_code, issue_id, project_id FROM cost_events ORDER BY created_at DESC LIMIT 1"`
    - **Expected:** All three columns populated

## Test 2: Plugin SDK Handshake

1. Create a minimal test plugin file `/tmp/test-plugin.js`:
   ```javascript
   const readline = require('readline');
   const rl = readline.createInterface({ input: process.stdin });
   rl.on('line', (line) => {
     try {
       const msg = JSON.parse(line);
       if (msg.method === 'initialize') {
         const response = JSON.stringify({
           jsonrpc: '2.0',
           id: msg.id,
           result: { ok: true, supportedMethods: ['onEvent', 'runJob'] }
         });
         process.stdout.write(response + '\n');
       } else if (msg.method === 'shutdown') {
         const response = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
         process.stdout.write(response + '\n');
         process.exit(0);
       } else {
         const response = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} });
         process.stdout.write(response + '\n');
       }
     } catch (e) { /* ignore parse errors */ }
   });
   ```
2. In ArchonOS: Plugins → Install Plugin → key: "test-plugin", path: "/tmp/test-plugin.js"
3. Click Enable on the plugin
4. **Expected:** Plugin status changes to "Active" (not "Error")
5. Check app logs for: `[plugin] Worker notification:` (if plugin sends notifications)

## Test 3: MCP Server with Claude Desktop

1. Build: `cd desktop/src-tauri && cargo build --bin archonos-mcp`
2. Settings → MCP Server → copy the JSON config
3. Paste into `~/.claude/claude_desktop_config.json` (merge with existing)
4. Restart Claude Desktop
5. In Claude Desktop: type "list my agents" or "what issues are open"
6. **Expected:** Claude uses ArchonOS MCP tools and returns real data

## Test 4: Git Worktree Creation

1. Create a project with a workspace pointing at a real git repo
   - Projects → New Project → set workspace CWD to a git repo path
2. Create an issue assigned to an agent in that project
3. Wake the agent for that issue
4. **Expected:** Check filesystem:
   ```bash
   ls ~/Library/Application\ Support/com.archonos.app/worktrees/
   ```
   Should contain a directory named after the issue identifier (e.g., `ARC-1-task-title`)
5. After run completes, workspace should be released

## Test 5: Activity Log

1. Create an agent → Approve an approval → Create an issue
2. Navigate to Activity page
3. **Expected:** See timestamped entries for `agent.created`, `approval.approved`, `issue.created`
4. Filter by "Agents" tab → only agent events shown

## Test 6: Company Portability (v3)

1. Create a company with agents (including org chart), skills, routines
2. Settings sidebar → Export company → save JSON file
3. Inspect JSON: `cat export.json | python3 -m json.tool | head -50`
   - **Expected:** Schema `archonos/v3`, agents have `reports_to` field, `config_revisions` array present
4. Delete the SQLite database
5. Restart app → onboarding → import the JSON file
6. **Expected:** All entities restored including org chart hierarchy

## Test 7: GitHub Skill Import

1. In the app, use the import_github_skill command (via a UI button if available, or via CLI):
   ```bash
   ./archonos skill import-github "https://github.com/some-org/some-repo/tree/main/skills/example-skill"
   ```
2. **Expected:** SKILL.md fetched, skill created in company_skills with `source_type = 'github'`

## Test 8: Feedback Votes

1. Issue Detail → Comments → click thumbs up on a comment
2. **Expected:** Icon highlights with accent color
3. Refresh page → vote persists
4. Check: `sqlite3 .../archonos.db "SELECT * FROM feedback_votes"`

## Build Verification

```bash
cd desktop/src-tauri
cargo check                           # Main app
cargo check --bin archonos-mcp        # MCP server
cargo check --bin archonos            # CLI
cd ..
npx vite build                        # Frontend
```

All four must pass with zero errors.
