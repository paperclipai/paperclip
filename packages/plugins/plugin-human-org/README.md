# Human Org & Work for Paperclip

This first-party plugin adds an importable human organization directory, a human work board backed by real Paperclip issues, issue-level human assignment, and optional Mattermost notifications.

## What it does

- Imports CSV or JSON human org charts.
- Stores reporting lines, capabilities, responsibilities, contact information, Mattermost usernames, and optional Paperclip user links.
- Rejects unknown/duplicate CSV headers, inconsistent row widths, malformed quoting, duplicate IDs, unknown managers, self-reporting, invalid email addresses/statuses, unsafe Mattermost usernames, and reporting cycles before committing the roster; profile updates and replacement deactivations are one database transaction.
- Creates and assigns Paperclip issues from a dedicated human work page.
- Assigns an existing issue from its plugin detail panel.
- Shows all imported-human work on a Kanban board driven by the issue's Paperclip status.
- Sends secure Mattermost incoming-webhook notifications with `@username` mentions and task links.
- Keeps webhook URLs in Paperclip Secrets rather than plugin data or logs.
- Namespaces and re-filters stored entities by company, preventing collisions when organizations reuse the same `external_id`.
- Uses Paperclip's immutable actor context for mutations: active owners, admins, and members can manage work; viewers are read-only.
- Paginates complete rosters, projects, assignments, and issue boards rather than truncating at one host page.
- Uses Paperclip's company-scoped atomic issue idempotency keys, a database-backed insert-only pending assignment as the notification claim, and same-worker in-flight request coalescing, so concurrent retries across worker processes produce one issue, one assignment, and at most one Mattermost delivery; request-ID reuse for another human is rejected. The pending assignment is durable before any webhook attempt, and a failed assignment write leaves no orphan claim, so a safe retry remains possible.
- Records explicit `pending`/`unknown` notification states when delivery may have succeeded but the final state write did not; automatic retries never redeliver an uncertain webhook.
- Enforces practical limits: 2,000,000 import characters, 5,000 people per import, bounded profile/list fields, 500-character task titles, and 50,000-character task descriptions.

Task-creation action callers must provide a unique `requestId` (1–128 safe characters). The bundled UI creates and retains this ID automatically across retries.

## Build

From the Paperclip repository root:

```bash
pnpm --filter @paperclipai/plugin-human-org build
pnpm --filter @paperclipai/plugin-human-org test
```

If `pnpm` is not installed globally:

```bash
npm exec --yes pnpm@9.15.4 -- --filter @paperclipai/plugin-human-org build
npm exec --yes pnpm@9.15.4 -- --filter @paperclipai/plugin-human-org test
```

## Install

Open **Company Settings → Plugin Manager**. Under **Available Plugins**, install **Human Org & Work**. For a source checkout, Paperclip discovers this package at `packages/plugins/plugin-human-org` and installs it as a local first-party plugin.

### Host compatibility

This release requires conflict-safe company-scoped plugin entities, single-window issue pagination, and plugin issue-create idempotency-key forwarding from the accompanying Paperclip source snapshot. The tutorial bundle includes `paperclip-human-org-core.patch` for older checkouts. Apply and review that patch before installing the tarball; do not bypass it if it does not apply cleanly.

The release tarball bundles its worker-side plugin SDK runtime. It installs in a clean npm project without fetching the unpublished workspace package `@paperclipai/plugin-sdk`.

See the [Human Org and Mattermost tutorial](https://github.com/paperclipai/paperclip/blob/master/doc/HUMAN_ORG_MATTERMOST_TUTORIAL.md) for complete setup, data format, usage, security, and troubleshooting instructions.
