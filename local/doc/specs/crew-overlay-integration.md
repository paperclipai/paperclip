# Crew Repo Integration: Single Bind Mount with Slug Aliasing

Implement a single Docker bind mount and server-side slug aliasing so that
company skills in the crew repo are auto-discovered without a manual import step.

**Scope: skills only.** Agent instruction bundles are out of scope — migration
of those is a separate, deliberate per-agent decision tracked in
`docs/specs/externalise-agent-instructions.md`.

## Background

Company skills currently require a manual `docker cp` + import dance because the
server prunes any `local_path` skill whose `sourceLocator` no longer exists on
the container filesystem. The crew repo (`~/Projects/linkcast/crew`) already
holds skills at:

```
crew/paperclip/companies/linkcast/skills/
  agent-delegate/
    SKILL.md
    scripts/
      agent-comment.sh
      agent-create-issue.sh
      agent-list-reports.sh
      agent-poll-issue.sh
```

The goal is to bind-mount this tree into the container so skills are permanently
accessible, and to teach the server to resolve company slugs (`linkcast`) to
paths without an extra env var.

## Bind Mount

In `docker/docker-compose.yml`, add to the `server` service:

```yaml
volumes:
  # Crew repo company assets (skills, and future agent instructions).
  # Read-write so the Paperclip UI skills editor can save changes back to the
  # crew repo directly. Git remains the canonical source of truth — UI edits
  # will appear as working-tree changes and must be committed normally.
  # Additional companies require additional mounts.
  - ${PAPERCLIP_OVERLAY_PATH}:/paperclip/companies:rw
```

`PAPERCLIP_OVERLAY_PATH` must be set in the deployment environment (e.g. `.env`)
and should point to the `paperclip/companies` subdirectory of the crew repo
(e.g. `~/Projects/linkcast/crew/paperclip/companies`). Only the `companies`
subtree is mounted — other files in `paperclip/` (such as the compose overlay)
are not exposed inside the container. The mount is
**read-write** so that the Paperclip UI skills editor works — saves land directly
in the crew repo and show up in `git diff`. Also add `PAPERCLIP_OVERLAY_PATH` to the
`server` service `environment` block so the path is visible for
logging/diagnostics if needed.

## UUID-to-Slug Aliasing

The server uses UUIDs internally. The crew repo uses slugs. The company `urlKey`
field already holds the slug and is available on every company record — no new
config is needed.

### New function in `home-paths.ts`

```typescript
// Returns /paperclip/companies/{urlKey}/skills if the bind mount is present,
// otherwise null. Callers fall back to the managed path when null is returned.
export function resolveCrewCompanySkillsDir(urlKey: string): string | null {
  const base = path.resolve("/paperclip/companies", urlKey, "skills");
  // Synchronous existence check is acceptable here — called once per
  // ensureSkillInventoryCurrent, not on every request.
  try {
    fs.statSync(base);
    return base;
  } catch {
    return null;
  }
}
```

The hardcoded `/paperclip/companies` matches the bind mount target and keeps the
implementation simple. If the mount is absent, all callers see `null` and
behaviour is unchanged.

### Auto-discovery in `company-skills.ts`

Modify `ensureSkillInventoryCurrent` to call a new helper
`syncCrewRepoSkills(companyId, urlKey)` after `ensureBundledSkills`:

```
ensureBundledSkills(companyId)
syncCrewRepoSkills(companyId, urlKey)      ← new
pruneMissingLocalPathSkills(companyId)
```

`syncCrewRepoSkills` behaviour:

1. Call `resolveCrewCompanySkillsDir(urlKey)`. If null, return immediately.
2. Scan the directory for subdirectories containing `SKILL.md`.
3. For each, call `readLocalSkillFromDir(companyId, skillDir)` (the existing
   helper) to build an `ImportedSkill`.
4. Upsert via `upsertImportedSkills`. The `sourceLocator` will be the
   bind-mounted path — permanent, so `pruneMissingLocalPathSkills` will never
   remove it while the mount is live.

Adding a new skill directory to the crew repo and triggering any company skills
API call is sufficient to register it — no `docker cp`, no manual import.
Removing a directory causes the prune pass to remove it from the catalog on the
next API call.

## Script source paths

Skills discovered this way have their scripts at:
```
/paperclip/companies/{slug}/skills/{skill-name}/scripts/
```

The `source` field in `PaperclipSkillEntry` (passed to adapters at runtime via
`config.paperclipRuntimeSkills`) will be this absolute bind-mounted path.
Adapters read `SKILL.md` from `{source}/SKILL.md` and scripts are directly
callable at `{source}/scripts/agent-poll-issue.sh` etc.

The `openrouter-local` skill sync implementation (see
`docs/specs/openrouter-local-skill-sync.md`) should document that SKILL.md
content may reference helper scripts via the `source` path injected by the
adapter, or via the known bind-mounted absolute path.

## Files to read before writing any code

```
server/src/home-paths.ts                    # add resolveCrewCompanySkillsDir
server/src/services/company-skills.ts       # add syncCrewRepoSkills, call from ensureSkillInventoryCurrent
docker/docker-compose.yml                   # add bind mount
```

## Key constraints

- If `/paperclip/companies` is not mounted, `resolveCrewCompanySkillsDir` returns
  null and the entire feature is a no-op. Existing deployments are unaffected.
- Mount is **read-write**. The UI skills editor writes back to the crew repo;
  changes appear as git working-tree modifications and must be committed
  deliberately.
- Agent instruction bundles (`agents/` subtree) are out of scope for this spec.
  The bind mount exposes them on disk but the server must not auto-resolve them.
- `gh` CLI is 1Password-shimmed; do not use it in scripts or tool calls.
- Docker must be rebuilt after adding the bind mount.
