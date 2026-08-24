---
title: Feature Support Case Assessment — Skills Store
summary: Support reference for the Skills Store feature (shipped v2026.618.0)
version: v2026.618.0
---

# Support Case Assessment: Skills Store

## Feature Summary

The Skills Store is an in-app marketplace where you can browse, install, and manage agent skills. Skills are first-class, installable units that give your agents new capabilities without hand-wiring files. The store shows install counts and provides a company-scoped catalog of available and installed skills.

## User-Facing Behavior

### Browsing the Store

- Access the Skills Store from the company settings or agent configuration
- Browse available skills with descriptions, install counts, and version info
- Skills are categorized by function (e.g., communication, data, development, publishing)

### Installing Skills

- Click "Install" on any skill in the store
- Installed skills are available to all agents in the company
- Installation is immediate — no restart required
- Some skills may require additional configuration (API keys, service endpoints)

### Skill Provenance

Skills have a clear provenance model:

| Provenance | Description |
|------------|-------------|
| Bundled | Ships with Paperclip, always available |
| Catalog | Available from the Skills Store |
| Runtime | Created at runtime by agents or system |
| Adapter-provided | Provided by the agent adapter |

### Managing Skills

- View installed skills from company settings
- Edit skill categories for organization
- Reset a skill to its default state
- Uninstall skills that are no longer needed
- Export skills for use in other instances

### CLI Integration

The CLI provides equivalent commands for skill management:

- `paperclip skill install <name>` — install a skill
- `paperclip skill list` — list installed skills
- `paperclip skill reset <name>` — reset a skill
- `paperclip skill audit` — audit installed skills
- `paperclip skill export <name>` — export a skill

## Known Issues & Limitations

### 1. Skill Permissions

Skill create/edit/delete is gated behind the `skills:create` permission. Lower-privileged principals can browse and view skills but cannot modify them. If a user cannot install or manage skills, verify their permission level.

### 2. No Sandboxing for Skills

Skills run within the agent's execution context. A skill with access to file system or network capabilities can access the same resources as the agent running it. There is no sandbox isolation between skills.

### 3. Skill Versioning

The Skills Store shows the current version of each skill. There is no built-in rollback mechanism — if a skill update causes issues, you must manually revert or contact support.

### 4. External Adapter Overrides

External adapter plugins can hot-install over a built-in adapter type (e.g., a newer Hermes implementation). This matching override behavior in the registry means a skill associated with a specific adapter may be shadowed by an external plugin.

### 5. Skill Configuration

Some skills require additional configuration after installation (API keys, endpoints, etc.). The skill's configuration is shown in the agent configuration panel. Unconfigured skills may fail at runtime.

## Troubleshooting

### Skill installation fails

1. Verify the user has the `skills:create` permission
2. Check that the skill is available in the store (not removed or deprecated)
3. Check server logs for installation errors
4. Try installing via CLI: `paperclip skill install <name>`

### Skill doesn't appear in agent context

1. Verify the skill is installed (check company settings → Skills)
2. Verify the agent has the correct capabilities configured
3. Some skills are adapter-specific — verify the agent's adapter type is compatible
4. Restart the agent's heartbeat or reassign the issue

### Skill fails at runtime

1. Check if the skill requires configuration (API keys, endpoints)
2. Check the agent's heartbeat logs for skill-related errors
3. Verify the skill is compatible with the agent's adapter type
4. Try resetting the skill: `paperclip skill reset <name>`

### Skill categories are not editable

1. Verify the user has `skills:create` permission
2. Category editing is available from company settings
3. If the UI doesn't show the edit option, check for a stale page cache

## Support Escalation Path

| Issue | Escalate To |
|-------|-------------|
| Skill store is empty or not loading | CTO — store backend issue |
| Skill installation permission denied | CTO — permission check (`skills:create`) |
| Skill fails at runtime consistently | CTO — skill implementation bug |
| External adapter overrides shadow built-in skills | CTO — registry override behavior |
| Skill reset doesn't restore defaults | CTO — reset implementation |

## Related Code Locations

- `ui/src/pages/CompanySkills.tsx` — skills store UI
- `server/src/services/company-skills.ts` — skills service
- `server/src/routes/company-skills.ts` — skills API routes
- `packages/shared/src/constants.ts` — permission constants