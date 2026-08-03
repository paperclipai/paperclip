# Tutorial: Human organization charts, Paperclip tasks, and Mattermost

**Plugin:** Human Org & Work (`paperclipai.plugin-human-org`)

**Audience:** Paperclip instance administrators, operations leaders, and project managers
**Outcome:** Import a human org chart, create or assign Paperclip work to people, manage that work on a Kanban board, and notify assignees in Mattermost.

---

## 1. What was added

The **Human Org & Work** first-party plugin adds four connected features:

1. **Human directory and org chart** — upload people with reporting lines, capabilities, and responsibilities.
2. **Human work board** — a Kanban view backed by real Paperclip issues and their statuses.
3. **Task assignment** — create a new task for an imported person or assign an existing issue from its detail page.
4. **Mattermost notifications** — send a supported incoming-webhook message and `@username` mention when work is assigned.

### Why Paperclip provides the board

This implementation does **not** depend on Mattermost Boards/Focalboard APIs. Those APIs are not a stable integration surface in the current Mattermost ecosystem. Paperclip remains the task system of record; Mattermost is the notification and discussion surface. This avoids duplicated task state and synchronization conflicts.

### Linked members versus external humans

- **Linked Paperclip member:** if `paperclip_user_id` matches an active company member, the plugin also sets the issue's normal `assignee_user_id`. The issue appears in the normal Paperclip human-assignee workflow and in the Human Work board.
- **External human:** if `paperclip_user_id` is blank, the plugin records the assignment in its company-scoped human-assignment store and displays it on the Human Work board. The normal Paperclip assignee remains empty. Mattermost notification still works when a username and webhook are configured.

If `paperclip_user_id` is supplied but does not identify an active member of the same company, task creation or assignment is rejected rather than silently downgrading the person to an external assignment.

The plugin never creates fake login accounts and never models humans as autonomous agents.

---

## 2. Prerequisites

You need:

- A self-hosted Paperclip checkout that includes `packages/plugins/plugin-human-org`.
- Paperclip instance-admin access to install a plugin.
- Company-admin or owner access to configure company secrets and plugin settings.
- For Mattermost notifications: permission to create an incoming webhook in the destination Mattermost channel.

### Release bundle compatibility

The standalone plugin tarball expects the conflict-safe company-scoped plugin-entity, atomic entity-batch/insert-only claim, single-window issue-pagination, atomic issue-idempotency, and outbound-error redaction host contracts included in this Paperclip source snapshot. Its worker-side SDK runtime is bundled, so installation does not fetch `@paperclipai/plugin-sdk` from npm. If you are installing it into an older checkout, first apply `paperclip-human-org-core.patch` from the tutorial bundle at the repository root:

```bash
git apply --check paperclip-human-org-core.patch
git apply paperclip-human-org-core.patch
```

Do not install the tarball into an older checkout if the compatibility patch does not apply cleanly. Update the checkout or review the conflicts instead; bypassing these core changes can break company isolation or omit issues beyond the first 500 records.

---

## 3. Build and verify the plugin

From the Paperclip repository root:

```bash
pnpm --filter @paperclipai/plugin-human-org build
pnpm --filter @paperclipai/plugin-human-org test
```

If `pnpm` is not available globally, use the repository's pinned version:

```bash
npm exec --yes pnpm@9.15.4 -- --filter @paperclipai/plugin-human-org build
npm exec --yes pnpm@9.15.4 -- --filter @paperclipai/plugin-human-org test
```

Expected outputs include:

- `packages/plugins/plugin-human-org/dist/worker.js`
- `packages/plugins/plugin-human-org/dist/manifest.js`
- `packages/plugins/plugin-human-org/dist/ui/index.js`
- A passing Vitest suite.

Paperclip can build an unbuilt bundled plugin during installation, but building first makes installation errors easier to diagnose.

---

## 4. Install the plugin

1. Sign in to Paperclip as an instance administrator.
2. Open **Company Settings → Plugin Manager**.
3. Find **Human Org & Work** under **Available Plugins**.
4. Select **Install**.
5. Review the requested capabilities. They are limited to:
   - reading projects and issues;
   - creating and updating issues;
   - reading company membership IDs for optional linking;
   - resolving one configured secret reference;
   - outbound HTTP for Mattermost;
   - registering the page, sidebar link, and issue detail view;
   - writing auditable activity entries.
6. Confirm that the plugin status is **ready**.

After installation, **Human Org & Work** appears in the Paperclip sidebar and as a panel on issue detail pages.

---

## 5. Configure Mattermost securely

Mattermost notifications are optional. The org directory and Human Work board function without them.

### 5.1 Create the incoming webhook

1. In Mattermost, choose the destination channel.
2. Open **Integrations → Incoming Webhooks → Add Incoming Webhook**.
3. Select the channel and create the webhook.
4. Copy the generated webhook URL.

Treat that URL as a credential: anyone holding it can post to the configured channel.

### 5.2 Store the URL as a Paperclip Secret

1. In Paperclip, open the selected company's **Settings → Secrets**.
2. Create a secret named, for example, `mattermost-human-work-webhook`.
3. Paste the complete Mattermost webhook URL as the secret value.
4. Save it.

Do not put the webhook URL in the org CSV, documentation, issue text, or plugin logs.

### 5.3 Bind the secret to the plugin

1. Return to **Company Settings → Plugin Manager**.
2. Open **Human Org & Work → Settings** for the selected company.
3. For **Mattermost incoming webhook**, choose the secret created above.
4. Set **Paperclip company URL** to the company URL users should open from Mattermost. Use the URL visible before an issue path, for example:

   ```text
   https://paperclip.example/QI
   ```

5. Keep **Notify Mattermost on assignment** enabled.
6. Save the company configuration.

The Human Org & Work page should show Mattermost as **Connected**. The plugin stores only a secret reference. It resolves the URL for a delivery and does not write the resolved value to plugin data or activity metadata.

---

## 6. Prepare the org chart

Start with [`human-org-chart-sample.csv`](./examples/human-org-chart-sample.csv).

### CSV columns

| Column | Required | Meaning |
|---|---:|---|
| `external_id` | Yes | Stable unique ID from HRIS or your own directory. Do not reuse it for another person. |
| `name` | Yes | Human-readable full name. |
| `email` | No | Contact email; validated when present. |
| `title` | No | Job title or role. |
| `reports_to_external_id` | No | Manager's `external_id`. Leave blank for a root/leader. |
| `capabilities` | No | `|`-separated skills, such as `rcm|payer-operations|analytics`. |
| `responsibilities` | No | `|`-separated owned outcomes or duties. |
| `mattermost_username` | No | Username without `@`; used for assignment mentions. |
| `paperclip_user_id` | No | Existing active Paperclip user ID for native human assignment. Leave blank for external humans. |
| `status` | No | `active` or `inactive`; defaults to `active`. |

### Example

```csv
external_id,name,email,title,reports_to_external_id,capabilities,responsibilities,mattermost_username,paperclip_user_id,status
exec-1,Asha Patel,asha@example.com,CEO,,strategy|budget,Set direction|Approve budget,asha,,active
eng-1,Diego Ruiz,diego@example.com,Engineer,exec-1,typescript|aws,Build services|Review code,diego,,active
```

### Validation rules

The complete upload is validated before any row is written. The import rejects:

- missing `external_id` or `name`;
- duplicate `external_id` values;
- malformed email addresses;
- status values other than `active` or `inactive`;
- managers that are not included in a full replacement upload or the merged existing roster for an incremental upload;
- a person reporting to themselves;
- direct or indirect reporting cycles.
- invalid or reserved Mattermost usernames (`all`, `channel`, `everyone`, and `here` are reserved);
- imports over 2,000,000 characters or 5,000 people;
- profile scalar fields over their documented implementation bounds, more than 100 capability/responsibility items, or list items over 200 characters.

CSV quoted fields, escaped quotes, commas, and embedded newlines are supported. Unknown or duplicate headers, inconsistent column counts, and quotes inside unquoted fields are rejected.

### JSON alternative

You may upload a JSON array using camelCase or CSV-style field names:

```json
[
  {
    "externalId": "ops-1",
    "name": "Maya Chen",
    "title": "Revenue Cycle Lead",
    "reportsToExternalId": "exec-1",
    "capabilities": ["rcm", "payer-operations"],
    "responsibilities": ["Own payer operations", "Escalate denials"],
    "mattermostUsername": "maya",
    "status": "active"
  }
]
```

---

## 7. Import the org chart

1. Open **Human Org & Work** from the Paperclip sidebar.
2. Under **Import org chart**, select your `.csv` or `.json` file.
3. Normally leave **Deactivate people omitted from this upload** unchecked. Existing profiles not in the file remain unchanged.
4. For a full roster replacement, check that option. Existing active profiles omitted from the upload are marked inactive; historical assignments remain auditable.
5. Select **Validate & import**.
6. Confirm the imported count and inspect the rendered org tree.

Imports are idempotent by `external_id`: importing the same file again updates existing profiles instead of creating duplicates. Profile updates and full-replacement deactivations commit in one database transaction, so a persistence failure does not leave a partial roster.

---

## 8. Create a new task for a human

1. On **Human Org & Work**, open **Create human task**.
2. Select the person. The dropdown includes name and title; inspect the org chart for capabilities and responsibilities.
3. Optionally select a Paperclip project.
4. Enter a concise title, description/acceptance criteria, and priority.
5. Select **Create & assign task**.

Paperclip creates a real issue in `todo`, records an insert-only pending human assignment, and only then attempts Mattermost delivery. The UI supplies a stable request ID; the host applies a company-scoped atomic issue idempotency key, the pending assignment doubles as a database-backed notification claim, and each worker also coalesces concurrent same-request actions. Concurrent retries across worker processes therefore produce one issue, one assignment, and at most one Mattermost delivery. If the assignment write fails, no orphan claim remains and a retry can safely persist the assignment before notifying. Reusing a request ID for another human is rejected. Direct action/API callers must supply their own unique `requestId` containing 1–128 letters, numbers, dots, underscores, colons, or hyphens. Task titles are limited to 500 characters and descriptions to 50,000 characters. The result line reports whether Mattermost was `sent`, `skipped`, `failed`, or `unknown`.

Assignment is not rolled back when Mattermost is unavailable. The issue and assignment remain authoritative in Paperclip. A definite `failed` delivery can be retried by reassigning after the webhook is fixed. An `unknown` state means delivery may already have succeeded but the final state write failed; automatic task retries intentionally do not redeliver it. Inspect Mattermost before making any intentional manual reassignment.

---

## 9. Assign an existing issue

1. Open any Paperclip issue.
2. Find the **Human assignment** plugin panel.
3. Select an imported person.
4. Select **Assign & notify**.

If the profile is linked to an active Paperclip member, the plugin clears agent ownership and sets that user as the core issue assignee. For an external person, agent ownership is cleared and the assignment is tracked on the Human Work board.

Use **Remove** to remove the plugin-managed human assignment. If the linked user is still the issue's current core assignee, Paperclip clears that user assignment as well. If the plugin-assignment update fails, the core assignee is restored before the action reports failure.

---

## 10. Operate the Human Work board

The board groups plugin-assigned issues by the live Paperclip status:

- Backlog
- To do
- In progress
- In review
- Done
- Cancelled

Use the left and right controls on a card to update its Paperclip issue status. Select the card title to open the full issue for comments, attachments, dependencies, and review.

The board does not copy issue content to a separate task database. It reads and updates the same Paperclip issue used by agents and projects.

---

## 11. Operating model

A practical daily workflow is:

1. Leaders maintain the roster from HRIS or a controlled CSV export.
2. Project managers inspect capability/responsibility data before assigning work.
3. Human owners receive a Mattermost mention with a Paperclip link.
4. Humans or coordinators update status in Paperclip.
5. Agents can continue to create related work, comments, or child issues without a second board sync.
6. Re-import the roster when roles, managers, capabilities, or responsibilities change.

### Recommended conventions

- Use immutable HRIS IDs for `external_id`.
- Keep capabilities short and reusable (`aws`, `typescript`, `rcm`, `credentialing`).
- Phrase responsibilities as owned outcomes (`Approve releases`, `Own payer enrollment`).
- Use one Mattermost channel for assignment notices per operating group.
- Do not use the optional `paperclip_user_id` until the person has an active company membership.

---

## 12. Troubleshooting

### Plugin is absent from Available Plugins

Build the plugin, restart the Paperclip server if bundled-package discovery was already cached, and reload Plugin Manager:

```bash
pnpm --filter @paperclipai/plugin-human-org build
```

### Import says “Unknown manager”

For an incremental import, the manager referenced by `reports_to_external_id` must exist either in the upload or in the current roster. For a full replacement, include the manager row in the same upload or remove the relationship.

### Import says “Reporting cycle detected”

Follow the manager chain for the listed IDs. At least one person indirectly reports back to themselves. Correct the source data and re-upload; no partial rows were saved.

### Mattermost shows “setup required”

Verify that:

- the webhook URL is stored in Paperclip Secrets;
- the plugin configuration binds the **secret**, not pasted plaintext;
- notifications are enabled;
- `paperclipBaseUrl` is set if you want clickable links.

### Mattermost delivery is `skipped`

Common reasons are no configured webhook, notifications disabled, or no `mattermost_username` on the selected profile.

### Mattermost delivery is `failed`

Regenerate or test the incoming webhook in Mattermost, verify outbound network access from the Paperclip server, and reassign the task to retry. The secret value is intentionally absent from logs.

### Mattermost delivery is `unknown`

The assignment was durable before delivery began, but Paperclip could not prove the final delivery state. Retrying the same task request returns the existing issue and does not send another webhook. Check Mattermost for the original notification before deliberately reassigning the task.

### Task is not in the normal Paperclip “assigned to me” view

The profile is external because `paperclip_user_id` is blank. It will still appear in the Human Work board. Link it to an active Paperclip member ID to use the native user-assignee workflow. If a nonblank ID is invalid or inactive, the plugin rejects assignment and reports the mapping error.

---

## 13. Security and audit behavior

- All profile and assignment entities are scoped by Paperclip company ID.
- Entity keys are internally namespaced by company, and every entity read is re-checked against its `scopeKind`/`scopeId` before use.
- A company cannot read another company's roster through plugin data actions.
- Import, task creation, assignment, status changes, and unassignment use Paperclip's immutable host actor context and require an active `owner`, `admin`, or `member` role. `viewer` memberships are read-only.
- The Mattermost webhook is represented as a `secret-ref` configuration field.
- Resolved webhook values are not persisted to entity data, activity metadata, or plugin logs.
- Outbound HTTP validation and DNS failures use value-free host errors, so malformed secret-backed URLs are not reflected through RPC logs.
- Invalid org charts are rejected before writes begin, and valid roster mutations commit atomically as one entity batch.
- Assignment and import actions write activity records without storing private webhook content.
- The plugin does not create authentication accounts or grant Paperclip permissions.

---

## 14. Verification performed for this implementation

The repository change was verified with:

- 36 plugin behavior tests covering strict CSV parsing and size limits, hierarchy validation, idempotent and incremental import, transactional roster rollback, identical-ID tenant isolation, viewer denial, active-member linking, external assignment, unassignment compensation, stale-assignment and live-assignee authority checks, atomic concurrent task creation with one assignment notification within and across worker processes, concurrent cross-human request-ID rejection, uncertain-notification reconciliation, pagination, Mattermost configuration/secret failure handling, Markdown/mention safety, and webhook non-disclosure;
- 42 Paperclip plugin SDK regression tests, including unscoped entity-access denial, rejection of conflicting and batched company/scope identifiers, production worker-RPC forwarding of atomic entity primitives, and issue idempotency-key forwarding;
- 264 plugin-related Paperclip server regression tests, including production entity tenant isolation, transactional batched upserts, insert-only entity claims, scoped API dispatch, worker-manager behavior, database-backed issue pagination beyond 500 records, atomic plugin issue idempotency, malformed outbound-URL redaction, static UI serving, installation, and auto-build;
- plugin SDK and server TypeScript type checking;
- manifest schema validation;
- worker and UI production builds;
- npm tarball generation confirming all install entrypoints are present and published metadata contains no `workspace:*` dependencies;
- sample-import and archive-integrity smoke tests;
- a static scan for hardcoded secrets and dangerous execution/XSS primitives.

The source package is at:

```text
packages/plugins/plugin-human-org
```

The sample CSV is at:

```text
doc/examples/human-org-chart-sample.csv
```
