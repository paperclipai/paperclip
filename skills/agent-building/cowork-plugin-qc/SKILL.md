---
name: cowork-plugin-qc
description: >
  Review and validate Cowork plugins for quality, completeness, and correctness.
  Use when asked to "review a plugin", "QC this plugin", "validate plugin
  structure", "check plugin quality", or when a Paperclip issue references
  plugin review. Performs structural validation, skill quality audit,
  connector verification, and adversarial trigger testing. NOT for building
  plugins (use cowork-plugin-builder) or reviewing Claude Code skills
  (use the QC agent checklist).
---

# Cowork Plugin QC

You are the quality gate for Cowork plugins. No plugin ships to a client without your sign-off.

Read the client brief. Read the plugin. Decide: PASS or FAIL.

## Review Checklist

### 1. Structural Validation

- [ ] `.claude-plugin/plugin.json` exists with valid JSON
- [ ] `name` field is kebab-case (lowercase, hyphens only)
- [ ] `version` is semver format
- [ ] `description` is present and meaningful
- [ ] Every skill directory under `skills/` contains a `SKILL.md`
- [ ] `.mcp.json` is valid JSON (if present)
- [ ] No hardcoded absolute paths anywhere in the plugin
- [ ] `${CLAUDE_PLUGIN_ROOT}` used for all intra-plugin path references
- [ ] No `commands/` directory (legacy format; should use `skills/*/SKILL.md`)
- [ ] `README.md` exists

### 2. Skill Quality (check EVERY skill)

- [ ] Frontmatter has `name` (kebab-case, matches directory name)
- [ ] Frontmatter has `description` (third-person, includes trigger phrases in quotes)
- [ ] Description includes what the skill is NOT for
- [ ] Body is imperative voice ("Parse the config" not "You should parse")
- [ ] Body under 3,000 words (target 1,500-2,000)
- [ ] Content over 100 lines uses `references/` for depth
- [ ] Output format template included for structured-output skills
- [ ] Execution flow is step-by-step for multi-step workflows
- [ ] Standalone mode works (skill functions without any connectors)
- [ ] Enhanced mode documented (what connectors add when available)

### 3. Connector Verification

- [ ] Every MCP server in `.mcp.json` has a valid `type` (http, sse, or stdio command)
- [ ] HTTP/SSE URLs match known endpoints (cross-check `references/mcp-directory.md`)
- [ ] stdio servers use `${CLAUDE_PLUGIN_ROOT}` for paths
- [ ] Required env vars documented in README
- [ ] If distributable: `CONNECTORS.md` exists with category-to-placeholder mapping
- [ ] If distributable: `~~category` placeholders used consistently in skill files
- [ ] If org-specific: no `~~` placeholders, tool names are hardcoded

### 4. Brief Compliance

- [ ] Read the original client brief (linked in the Paperclip issue)
- [ ] Every requested workflow has a corresponding skill
- [ ] No skills were built that the brief didn't ask for (scope creep)
- [ ] All client tools mentioned in brief are wired in `.mcp.json`
- [ ] Plugin category matches what the brief specified

### 5. Adversarial Trigger Testing

Write 3 prompts that SHOULD NOT trigger any skill in this plugin but might due to keyword overlap. Evaluate whether each skill's description would correctly exclude them.

| Prompt | Target Skill | Should Fire? | Would Fire? | Result |
|--------|-------------|-------------|-------------|--------|
| ... | ... | NO | NO/YES | pass/fail |

### 6. Packaging Readiness

- [ ] Plugin can be zipped without errors
- [ ] No `.DS_Store`, `.git`, or temp files would be included
- [ ] README covers: overview, components list, setup, usage, customization

## Verdict

Post review as a comment on your Paperclip issue:

```markdown
## Plugin QC: [Plugin Name]

### Structure
[pass/fail per item]

### Skills Reviewed
| Skill | Lines | Triggers | Output Format | Verdict |
|-------|-------|----------|---------------|---------|
| ... | ... | ... | ... | pass/fail |

### Connectors
[verified/unverified per server]

### Adversarial Tests
| Prompt | Should Fire? | Would Fire? | Result |
|--------|-------------|-------------|--------|

### Issues Found
- [issue 1]
(or "None")

### Verdict: PASS / FAIL
[If FAIL: specific items that need fixing]
```

## PASS Flow

1. Post review comment with PASS verdict
2. Mark your issue done

## FAIL Flow

1. Post review comment with FAIL verdict and specific failures
2. Create a fix issue assigned to PluginBuilder:

```
POST /api/companies/{companyId}/issues
{
  "title": "Fix plugin: [PLUGIN NAME] — QC failures",
  "body": "[specific failures and what to fix]",
  "projectId": "{projectId}",
  "assigneeAgentId": "{pluginBuilderId}",
  "status": "in_progress"
}
```

3. Mark your own issue done

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "The structure looks fine, I'll skip reading every skill" | One bad skill description means the whole plugin has a dead feature the client paid for. Read every SKILL.md. |
| "The MCP URLs are probably right" | Wrong URLs silently fail. The client will think the plugin is broken. Verify against the directory. |
| "This is close enough to pass" | Close enough ships a bug to a paying client. FAIL it. The fix takes 10 minutes; the client complaint takes hours. |
| "I don't need adversarial tests for a simple plugin" | Simple plugins with bad descriptions fire on the wrong prompts. 3 adversarial tests take 2 minutes. |
| "The brief was vague so I can't check scope" | Comment asking for clarification. Never pass without a brief check. |
