---
name: release
description: >
  Coordinate a full Paperclip release across engineering, website publishing,
  and social announcement. Use when CTO/CEO requests "do a release" or
  "release vX.Y.Z". Runs pre-flight checks, generates changelog via
  release-changelog, executes npm release, creates cross-project follow-up
  tasks, and posts a release wrap-up.
---

# Release Coordination Skill

Run the full Paperclip release process as an organizational workflow, not just
an npm publish.

This skill coordinates:
- User-facing changelog generation (`release-changelog` skill)
- Canary publish to npm (`scripts/release.sh --canary`)
- Docker smoke test of the canary (`scripts/docker-onboard-smoke.sh`)
- Promotion to `latest` after canary is verified
- Website publishing task creation
- CMO announcement task creation
- Final release summary with links

---

## Trigger

Use this skill when leadership asks for:
- "do a release"
- "release {patch|minor|major}"
- "release vX.Y.Z"

---

## Preconditions

Before proceeding, verify all of the following:

1. `skills/release-changelog/SKILL.md` exists and is usable.
2. The `release-changelog` dependency work is complete/reviewed before running this flow.
3. App repo working tree is clean.
4. There are commits since the last release tag.
5. You have release permissions (`npm whoami` succeeds for real publish).
6. If running via Paperclip, you have issue context for posting status updates.

If any precondition fails, stop and report the blocker.

---

## Inputs

Collect these inputs up front:

- Release request source issue (if in Paperclip)
- Requested bump (`patch|minor|major`) or explicit version (`vX.Y.Z`)
- Whether this run is dry-run or live publish
- Company/project context for follow-up issue creation

---

## Step 0 — Idempotency Guards

Each step in this skill is designed to be safely re-runnable. Before executing
any step, check whether it has already been completed:

| Step | How to Check | If Already Done |
|---|---|---|
| Changelog | `releases/v{version}.md` exists | Read it, ask reviewer to confirm or update. Do NOT regenerate without asking. |
| Canary publish | `npm view paperclipai@{version}` succeeds | Skip canary publish. Proceed to smoke test. |
| Smoke test | Manual or scripted verification | If canary already verified, proceed to promote. |
| Promote | `git tag v{version}` exists | Skip promotion entirely. A tag means the version is already promoted to latest. |
| Website task | Search Paperclip issues for "Publish release notes for v{version}" | Skip creation. Link the existing task. |
| CMO task | Search Paperclip issues for "release announcement tweet for v{version}" | Skip creation. Link the existing task. |

**The golden rule:** If a git tag `v{version}` already exists, the release is
fully promoted. Only post-publish tasks (website, CMO, wrap-up) should proceed.
If the version exists on npm but there's no git tag, the canary was published but
not yet promoted — resume from smoke test.

**Iterating on changelogs:** You can re-run this skill with an existing changelog
to refine it _before_ the npm publish step. The `release-changelog` skill has
its own idempotency check and will ask the reviewer what to do with an existing
file. This is the expected workflow for iterating on release notes.

---

## Step 1 - Pre-flight and Version Decision

Run pre-flight in the App repo root:

```bash
LAST_TAG=$(git tag --sort=-version:refname | head -1)
git diff --quiet && git diff --cached --quiet
git log "${LAST_TAG}..HEAD" --oneline --no-merges | head -50
```

Then detect minimum required bump:

```bash
# migrations
git diff --name-only "${LAST_TAG}..HEAD" -- packages/db/src/migrations/

# schema deltas
git diff "${LAST_TAG}..HEAD" -- packages/db/src/schema/

# breaking commit conventions
git log "${LAST_TAG}..HEAD" --format="%s" | rg -n 'BREAKING CHANGE|BREAKING:|^[a-z]+!:' || true
```

Bump policy:
- Destructive migration/API removal/major changeset/breaking commit -> `major`
- Additive migrations or clear new features -> at least `minor`
- Fixes-only -> `patch`

If requested bump is lower than required minimum, escalate bump and explain why.

---

## Step 2 - Generate Changelog Draft

First, check if `releases/v{version}.md` already exists. If it does, the
`release-changelog` skill will detect this and ask the reviewer whether to keep,
regenerate, or update it. **Do not silently overwrite an existing changelog.**

Invoke the `release-changelog` skill and produce:
- `releases/v{version}.md`
- Sections ordered as: Breaking Changes (if any), Highlights, Improvements, Fixes, Upgrade Guide (if any)

Required behavior:
- Present the draft for human review.
- Flag ambiguous categorization items.
- Flag bump mismatches before publish.
- Do not publish until reviewer confirms.

---

## Step 3 — Publish Canary

The canary is the gatekeeper: every release goes to npm as a canary first. The
`latest` tag is never touched until the canary passes smoke testing.

**Idempotency check:** Before publishing, check if this version already exists
on npm:

```bash
# Check if canary is already published
npm view paperclipai@{version} version 2>/dev/null && echo "ALREADY_PUBLISHED" || echo "NOT_PUBLISHED"

# Also check git tag
git tag -l "v{version}"
```

- If a git tag exists → the release is already fully promoted. Skip to Step 6.
- If the version exists on npm but no git tag → canary was published but not yet
  promoted. Skip to Step 4 (smoke test).
- If neither exists → proceed with canary publish.

### Publishing the canary

Use `release.sh` with the `--canary` flag (see script changes below):

```bash
# Dry run first
./scripts/release.sh {patch|minor|major} --canary --dry-run

# Publish canary (after dry-run review)
./scripts/release.sh {patch|minor|major} --canary
```

This publishes all packages to npm with the `canary` dist-tag. The `latest` tag
is **not** updated. Users running `npx paperclipai onboard` still get the
previous stable version.

After publish, verify the canary is accessible:

```bash
npm view paperclipai@canary version
# Should show the new version
```

**How `--canary` works in release.sh:**
- Steps 1-5 are the same (preflight, changeset, version, build, CLI bundle)
- Step 6 uses `npx changeset publish --tag canary` instead of `npx changeset publish`
- Step 7 does NOT commit or tag — the commit and tag happen later in the promote
  step, only after smoke testing passes

**Script changes required:** Add `--canary` support to `scripts/release.sh`:
- Parse `--canary` flag alongside `--dry-run`
- When `--canary`: pass `--tag canary` to `changeset publish`
- When `--canary`: skip the git commit and tag step (Step 7)
- When NOT `--canary`: behavior is unchanged (backwards compatible)

---

## Step 4 — Smoke Test the Canary

Run the canary in a clean Docker environment to verify `npx paperclipai onboard`
works end-to-end.

### Automated smoke test

Use the existing Docker smoke test infrastructure with the canary version:

```bash
PAPERCLIPAI_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

This builds a clean Ubuntu container, installs `paperclipai@canary` via npx, and
runs the onboarding flow. The UI is accessible at `http://localhost:3131`.

### What to verify

At minimum, confirm:

1. **Container starts** — no npm install errors, no missing dependencies
2. **Onboarding completes** — the wizard runs through without crashes
3. **Server boots** — UI is accessible at the expected port
4. **Basic operations** — can create a company, view the dashboard

For a more thorough check (stretch goal — can be automated later):

5. **Browser automation** — script Playwright/Puppeteer to walk through onboard
   in the Docker container's browser and verify key pages render

### If smoke test fails

- Do NOT promote the canary.
- Fix the issue, publish a new canary (re-run Step 3 — idempotency guards allow
  this since there's no git tag yet).
- Re-run the smoke test.

### If smoke test passes

Proceed to Step 5 (promote).

---

## Step 5 — Promote Canary to Latest

Once the canary passes smoke testing, promote it to `latest` so that
`npx paperclipai onboard` picks up the new version.

### Promote on npm

```bash
# For each published package, move the dist-tag from canary to latest
npm dist-tag add paperclipai@{version} latest
npm dist-tag add @paperclipai/server@{version} latest
npm dist-tag add @paperclipai/cli@{version} latest
npm dist-tag add @paperclipai/shared@{version} latest
npm dist-tag add @paperclipai/db@{version} latest
npm dist-tag add @paperclipai/adapter-utils@{version} latest
npm dist-tag add @paperclipai/adapter-claude-local@{version} latest
npm dist-tag add @paperclipai/adapter-codex-local@{version} latest
npm dist-tag add @paperclipai/adapter-openclaw-gateway@{version} latest
```

**Script option:** Add `./scripts/release.sh --promote {version}` to automate
the dist-tag promotion for all packages.

### Commit and tag

After promotion, finalize in git (this is what `release.sh` Step 7 normally
does, but was deferred during canary publish):

```bash
git add .
git commit -m "chore: release v{version}"
git tag "v{version}"
```

### Verify promotion

```bash
npm view paperclipai@latest version
# Should now show the new version

# Final sanity check
npx --yes paperclipai@latest --version
```

---

## Step 6 - Create Cross-Project Follow-up Tasks

**Idempotency check:** Before creating tasks, search for existing ones:

```
GET /api/companies/{companyId}/issues?q=release+notes+v{version}
GET /api/companies/{companyId}/issues?q=announcement+tweet+v{version}
```

If matching tasks already exist (check title contains the version), skip
creation and link the existing tasks instead. Do not create duplicates.

Create at least two tasks in Paperclip (only if they don't already exist):

1. Website task: publish changelog for `v{version}`
2. CMO task: draft announcement tweet for `v{version}`

When creating tasks:
- Set `parentId` to the release issue id.
- Carry over `goalId` from the parent issue when present.
- Include `billingCode` for cross-team work when required by company policy.
- Mark website task `high` priority if release has breaking changes.

Suggested payloads:

```json
POST /api/companies/{companyId}/issues
{
  "projectId": "{websiteProjectId}",
  "parentId": "{releaseIssueId}",
  "goalId": "{goalId-or-null}",
  "billingCode": "{billingCode-or-null}",
  "title": "Publish release notes for v{version}",
  "priority": "medium",
  "status": "todo",
  "description": "Publish /changelog entry for v{version}. Include full markdown from releases/v{version}.md and prominent upgrade guide if breaking changes exist."
}
```

```json
POST /api/companies/{companyId}/issues
{
  "projectId": "{workspaceProjectId}",
  "parentId": "{releaseIssueId}",
  "goalId": "{goalId-or-null}",
  "billingCode": "{billingCode-or-null}",
  "title": "Draft release announcement tweet for v{version}",
  "priority": "medium",
  "status": "todo",
  "description": "Draft launch tweet with top 1-2 highlights, version number, and changelog URL. If breaking changes exist, include an explicit upgrade-guide callout."
}
```

---

## Step 7 - Wrap Up the Release Issue

Post a concise markdown update linking:
- Release issue
- Changelog file (`releases/v{version}.md`)
- npm package URL (both `@canary` and `@latest` after promotion)
- Canary smoke test result (pass/fail, what was tested)
- Website task
- CMO task
- Final changelog URL (once website publishes)
- Tweet URL (once published)

Completion rules:
- Keep issue `in_progress` until canary is promoted AND website + social tasks
  are done.
- Mark `done` only when all required artifacts are published and linked.
- If waiting on another team, keep open with clear owner and next action.

---

## Release Flow Summary

The full release lifecycle is now:

```
1. Generate changelog      → releases/v{version}.md (review + iterate)
2. Publish canary           → npm @canary dist-tag (latest untouched)
3. Smoke test canary        → Docker clean install verification
4. Promote to latest        → npm @latest dist-tag + git tag + commit
5. Create follow-up tasks   → website changelog + CMO tweet
6. Wrap up                  → link everything, close issue
```

At any point you can re-enter the flow — idempotency guards detect which steps
are already done and skip them. The changelog can be iterated before or after
canary publish. The canary can be re-published if the smoke test reveals issues
(just fix + re-run Step 3). Only after smoke testing passes does `latest` get
updated.

---

## Paperclip API Notes (When Running in Agent Context)

Use:
- `GET /api/companies/{companyId}/projects` to resolve website/workspace project IDs.
- `POST /api/companies/{companyId}/issues` to create follow-up tasks.
- `PATCH /api/issues/{issueId}` with comments for release progress.

For issue-modifying calls, include:
- `Authorization: Bearer $PAPERCLIP_API_KEY`
- `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`

---

## Failure Handling

If blocked, update the release issue explicitly with:
- what failed
- exact blocker
- who must act next
- whether any release artifacts were partially published

Never silently fail mid-release.
