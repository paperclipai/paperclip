# Hermes Skills Integration in Paperclip

## Overview

Paperclip's Hermes adapter (`hermes_local` and `hermes_gateway`) integrates with Hermes Agent's skill system to provide both Paperclip-managed and Hermes-native skills to agents.

**Last Updated:** June 28, 2026

## Skill Loading Mechanism

### Architecture

The Hermes adapter implements a dual-source skill loading strategy:

1. **Paperclip-managed skills** — Bundled with the adapter package at `~/code/paperclip/packages/adapters/hermes/skills/`
   - Togglable from Paperclip UI
   - Managed through Paperclip's skill sync API
   - Marked as `managed: true`, `origin: "company_managed"`
   
2. **Hermes-native skills** — Loaded from `~/.hermes/skills/`
   - Read-only from Paperclip's perspective
   - Always loaded by Hermes CLI (all available skills are enabled by default)
   - Marked as `managed: false`, `origin: "user_installed"`, `readOnly: true`

### Skill Discovery Process

The adapter's skill discovery is implemented in `packages/adapters/hermes/src/server/skills.ts` and follows this flow:

```typescript
async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  // 1. Resolve HOME directory (respects adapter config env.HOME override)
  const home = resolveHermesHome(config);
  const hermesSkillsHome = path.join(home, ".hermes", "skills");
  
  // 2. Scan Paperclip-managed skills (bundled with adapter)
  const paperclipEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, paperclipEntries);
  
  // 3. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  
  // 4. Merge: Paperclip skills first, then Hermes skills (de-duped by key)
  // ...
}
```

### Hermes Skill Directory Structure

Hermes expects skills in this structure at `~/.hermes/skills/`:

```
~/.hermes/skills/
├── category-name/
│   ├── skill-name/
│   │   └── SKILL.md          # Skill definition with frontmatter
│   └── SKILL.md              # Category-level skill (optional)
└── another-category/
    └── another-skill/
        └── SKILL.md
```

Each `SKILL.md` must contain YAML frontmatter:

```yaml
---
name: skill-name
description: Brief description
version: 1.0.0
category: category-name
---

# Skill content follows...
```

### Hermes CLI Default Behavior

The Hermes CLI **automatically loads all skills** from `~/.hermes/skills/` without requiring explicit configuration:

- **Default skills path:** `~/.hermes/skills/` (hardcoded default)
- **Config override:** `skills.external_dirs: []` in `~/.hermes/config.yaml` can add additional directories
- **Session preload:** `hermes chat --skills skill1,skill2` preloads specific skills for a session
- **No path config needed:** The adapter does NOT need to configure the skills path — Hermes CLI handles it

## Configuration

### Hermes Config (`~/.hermes/config.yaml`)

```yaml
skills:
  external_dirs: []              # Optional: additional skill directories
  template_vars: true            # Enable {{variable}} substitution in skills
  inline_shell: false            # Allow inline shell execution in skills
  inline_shell_timeout: 10       # Timeout for inline shell commands
  guard_agent_created: false     # Require approval for agent-created skills
  write_approval: false          # Require approval for skill modifications
  creation_nudge_interval: 15    # Interval for skill creation nudges
```

**Key Points:**
- `external_dirs` is empty by default — Hermes uses `~/.hermes/skills/` as the primary source
- No explicit path configuration is needed for the default location
- The adapter scans this location automatically

### Paperclip Adapter Config

When creating a Hermes agent in Paperclip, you can specify desired skills in the adapter config:

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4",
    "desiredSkills": ["paperclip", "github-issues", "linear"],
    "env": {
      "HOME": "/custom/home"  // Optional: override HOME directory
    }
  }
}
```

**Important:** `desiredSkills` applies only to **Paperclip-managed skills**. All Hermes-native skills from `~/.hermes/skills/` are always loaded.

## Skill Snapshot API

The adapter exposes three skill management functions:

### 1. `listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot>`

Returns a complete snapshot of available skills:

```typescript
{
  adapterType: "hermes_local",
  supported: true,
  mode: "persistent",  // Hermes manages its own skill loading
  desiredSkills: ["skill1", "skill2"],
  entries: [
    {
      key: "paperclip",
      runtimeName: "paperclip",
      desired: true,
      managed: true,           // Paperclip-managed
      state: "configured",
      origin: "company_managed",
      readOnly: false,
      sourcePath: "/path/to/adapter/skills/paperclip/SKILL.md",
      locationLabel: "Managed by Paperclip"
    },
    {
      key: "github-issues",
      runtimeName: "github-issues",
      desired: true,
      managed: false,          // Hermes-native
      state: "installed",
      origin: "user_installed",
      readOnly: true,          // Cannot toggle from Paperclip
      sourcePath: "~/.hermes/skills/github/github-issues/SKILL.md",
      locationLabel: "~/.hermes/skills/github/github-issues"
    }
  ],
  warnings: []
}
```

### 2. `syncSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot>`

For Hermes adapter, this is a **no-op** that returns the current snapshot:

```typescript
export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  // Hermes manages its own skill loading — sync is a no-op.
  // Return the current snapshot so the UI stays in sync.
  return buildHermesSkillSnapshot(ctx.config);
}
```

**Rationale:** Hermes CLI loads all available skills automatically. Paperclip cannot selectively enable/disable Hermes-native skills.

### 3. `resolveDesiredSkillNames(config, availableEntries): string[]`

Resolves the list of desired skill names from adapter config, delegating to Paperclip's standard resolution logic.

## Verification

### Current State (as of June 28, 2026)

```bash
$ hermes skills list | tail -3
└─────────────────────────┴──────────────────────┴─────────┴─────────┴─────────┘
0 hub-installed, 72 builtin, 38 local — 110 enabled, 0 disabled
```

### Skill Count Breakdown

- **72 builtin** — Hermes core skills (shipped with Hermes Agent)
- **38 local** — User-installed skills in `~/.hermes/skills/`
- **Total: 110 enabled skills**

The count increased from 107 to 110 after consolidating skills to `~/.hermes/skills/`, confirming that:
1. Hermes CLI correctly reads from `~/.hermes/skills/`
2. All skills in that directory are automatically loaded
3. No additional configuration is required

### Testing Skill Access

To verify Paperclip can access Hermes skills:

```bash
# 1. List skills via Hermes CLI
hermes skills list

# 2. Start Paperclip dev server
cd ~/code/paperclip
pnpm dev

# 3. Create a Hermes agent in Paperclip UI
# 4. Assign a task and observe skill loading in logs
# 5. Check skill snapshot via API:
curl http://localhost:3101/api/skills/hermes_local?agentId=<agent-id>
```

## Implementation Details

### File Locations

- **Adapter source:** `~/code/paperclip/packages/adapters/hermes/`
- **Skill scanning logic:** `packages/adapters/hermes/src/server/skills.ts`
- **Adapter entry point:** `packages/adapters/hermes/src/index.ts`
- **Server registration:** `~/code/paperclip/server/src/adapters/registry.ts`
- **Hermes skills directory:** `~/.hermes/skills/` (canonical source)

### Key Functions

#### `scanHermesSkills(skillsHome: string): Promise<AdapterSkillEntry[]>`

Recursively scans the Hermes skills directory:

1. Reads top-level category directories
2. Checks for category-level `SKILL.md` files
3. Scans subdirectories for skill-level `SKILL.md` files
4. Parses YAML frontmatter for metadata
5. Returns array of skill entries with:
   - `key`: skill name
   - `runtimeName`: same as key
   - `desired`: always `true` (Hermes loads all)
   - `managed`: `false` (Hermes-managed)
   - `state`: `"installed"`
   - `readOnly`: `true` (cannot toggle from Paperclip)
   - `locationLabel`: `~/.hermes/skills/<category>/<skill>`

#### `parseSkillFrontmatter(content: string): SkillFrontmatter`

Extracts YAML frontmatter from `SKILL.md`:

```typescript
interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}
```

#### `resolveHermesHome(config: Record<string, unknown>): string`

Determines the HOME directory for skill scanning:

```typescript
function resolveHermesHome(config: Record<string, unknown>): string {
  const env = typeof config.env === 'object' ? config.env : {};
  const configuredHome = asString(env.HOME);
  return configuredHome ? path.resolve(configuredHome) : os.homedir();
}
```

This allows adapter config to override HOME:

```json
{
  "adapterConfig": {
    "env": {
      "HOME": "/custom/home"
    }
  }
}
```

Skills would be scanned from `/custom/home/.hermes/skills/`.

## Comparison with Other Adapters

| Feature | Hermes | Claude Code | Codex | OpenCode |
|---------|--------|-------------|-------|----------|
| Skill Source | Dual (Paperclip + Hermes native) | Paperclip-managed only | Paperclip-managed only | Paperclip-managed only |
| Native Skill Loading | ✅ Yes (`~/.hermes/skills/`) | ❌ No | ❌ No | ❌ No |
| Toggle Skills | Paperclip-managed only | ✅ Yes | ✅ Yes | ✅ Yes |
| Skill Sync | No-op (Hermes manages) | Full sync | Full sync | Full sync |
| Session Persistence | ✅ Native | ❌ No | ❌ No | ✅ Native |

## Troubleshooting

### Skills Not Loading

**Problem:** Hermes agent doesn't see expected skills

**Solution:**
1. Verify skill directory exists: `ls -la ~/.hermes/skills/`
2. Check skill structure: `find ~/.hermes/skills/ -name "SKILL.md"`
3. Validate frontmatter: `head -20 ~/.hermes/skills/<category>/<skill>/SKILL.md`
4. Test Hermes CLI directly: `hermes skills list`
5. Check adapter HOME override: Review `adapterConfig.env.HOME` in agent config

### Duplicate Skills

**Problem:** Same skill key appears twice in Paperclip UI

**Solution:**
- Paperclip-managed skills take precedence
- Hermes-native skills are skipped if `availableByKey.has(entry.key)`
- Remove duplicate from either source (not both)

### Read-Only Skills

**Problem:** Cannot toggle Hermes-native skill from Paperclip UI

**Expected Behavior:**
- Hermes-native skills are marked `readOnly: true`
- Paperclip cannot modify `~/.hermes/skills/` contents
- Use `hermes skills install/uninstall` to manage Hermes-native skills

### Skill Count Mismatch

**Problem:** Paperclip shows different count than `hermes skills list`

**Explanation:**
- `hermes skills list` shows **all** skills (builtin + local)
- Paperclip `listSkills` shows **merged** skills (Paperclip-managed + Hermes-native)
- De-duplication may reduce count if keys overlap

## Future Enhancements

**Potential improvements (not currently implemented):**

1. **Selective skill loading** — Add adapter config to filter which Hermes-native skills to expose
2. **Skill caching** — Cache skill snapshots to reduce filesystem I/O
3. **Hot reload** — Watch `~/.hermes/skills/` for changes and invalidate cache
4. **Skill health checks** — Validate `SKILL.md` structure and report issues
5. **Skill usage tracking** — Log which skills are invoked per heartbeat
6. **Skill recommendations** — Suggest relevant skills based on task content

## References

- **Hermes Agent:** https://github.com/NousResearch/hermes-agent
- **Hermes Skills Hub:** https://hermes.nousresearch.com/skills
- **Paperclip Adapter Docs:** `~/code/paperclip/packages/adapters/AUTHORING.md`
- **Adapter Utils:** `~/code/paperclip/packages/adapter-utils/`

## Change Log

### 2026-06-28: Initial Documentation
- Documented dual-source skill loading mechanism
- Verified Hermes CLI defaults to `~/.hermes/skills/`
- Confirmed adapter correctly scans and merges skills
- Tested with 110 total skills (72 builtin, 38 local)
- No configuration changes needed — system works as designed
