# Push Convention — claude-private / claude-plugins

Every skill or plugin created during a session follows a three-stage promotion pipeline:

```
Session workspace  ──▶  claude-private  ──▶  Paperclip marketplace
```

---

## Stage 1 — Session (Develop)

Work in the standard locations inside this repo:

| Artifact | Location |
|----------|----------|
| Claude skill | `skills/<skill-name>/SKILL.md` + supporting files |
| Paperclip plugin | `packages/plugins/examples/<plugin-name>/` or `packages/plugins/<name>/` |

Iterate locally. Skills symlinked to `~/.claude/skills/` are live immediately.
Plugins install via the local-path API (`POST /api/plugins/install`).

---

## Stage 2 — claude-private (Commit)

`claude-private` is a private GitHub repository (`github.com/anhermon/claude-private`)
that tracks Angel's custom skills and plugins separately from the upstream `paperclip` repo.

**Local path:** `C:\Users\User\claude-private\`

**Repository structure:**
```
claude-private/
  skills/
    <skill-name>/       ← mirrors paperclip/skills/<skill-name>/
  plugins/
    <plugin-name>/      ← mirrors packages/plugins/<plugin-name>/
  README.md
```

**Commit convention:**
```
feat(skills/<name>): <short description>
feat(plugins/<name>): <short description>
fix(skills/<name>): <short description>
```

Always append:
```
Co-Authored-By: Paperclip <noreply@paperclip.ing>
```

---

## Stage 3 — Marketplace (Promote)

"Marketplace" = the Paperclip company skills library.

Skills imported here become installable on any agent in the company
via `POST /api/agents/:agentId/skills/sync`.

Future path: publish to `skills.sh` (the public Paperclip skill registry)
for community discovery. Requires a `skills.sh` account (not yet configured).

---

## The `promote-skill.sh` Script

One command covers stages 2 and 3:

```bash
# From C:\Users\User\paperclip\
./scripts/promote-skill.sh <skill-name>
```

What it does:
1. Copies `paperclip/skills/<name>/` → `claude-private/skills/<name>/`
2. Commits and pushes to `claude-private` (if remote is configured)
3. Calls `POST /api/companies/:companyId/skills/import` with the local path

Optional flags:
- `--no-git`    Skip commit/push (useful during iteration)
- `--no-import` Skip marketplace import

Required env vars for the import step:
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_API_URL` (defaults to `http://127.0.0.1:3100`)

Optional override:
- `CLAUDE_PRIVATE_DIR` — path to the `claude-private` checkout (defaults to `../claude-private` relative to the paperclip repo root)

---

## First-time Setup

1. **Create the remote on GitHub:**
   ```bash
   # In the GitHub UI: new private repo → anhermon/claude-private
   cd C:\Users\User\claude-private
   git remote add origin https://github.com/anhermon/claude-private.git
   git push -u origin main
   ```

2. **Configure the `claude-plugins` project workspace** so `scan-projects` can
   discover skills automatically (one-time, via Paperclip UI or API):
   ```json
   {
     "repoUrl": "https://github.com/anhermon/claude-private",
     "cwd": "C:\\Users\\User\\claude-private"
   }
   ```

3. **Run a promotion** to verify end-to-end:
   ```bash
   export PAPERCLIP_API_KEY=<key>
   export PAPERCLIP_COMPANY_ID=dbc742c7-9a38-4542-936b-523dfa3a7fd2
   ./scripts/promote-skill.sh paperclip --no-git --no-import  # dry-run copy only
   ```

---

## Plugin Pipeline

Plugins follow the same convention but the steps differ slightly:

| Step | Action |
|------|--------|
| Develop | Scaffold in `packages/plugins/examples/<name>/` using `paperclip-create-plugin` skill |
| Test    | `pnpm --filter <package> typecheck && pnpm --filter <package> test && pnpm --filter <package> build` |
| Commit  | Copy built output to `claude-private/plugins/<name>/`, commit |
| Deploy  | Install via `POST /api/plugins/install` with local path |
| Publish | Future: `npm publish` with `@anhermon/` scope |

There is no `promote-plugin.sh` yet — plugins are committed manually until the
build output format stabilises.

---

## Paperclip Issue Tracking

All skill/plugin work is tracked under the `claude-plugins` project in Paperclip.
Create a task per skill or plugin promoted, linking to the relevant commit.
