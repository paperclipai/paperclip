# Tool enablement runbook: what is on, off, hard-blocked, and hidden for shared companies

Audience: anyone who needs to change which tools agents can use (for example "let agents tag emails" or "turn off
send email everywhere"). Read this before editing any allowlist. It describes the code as of 2026-11-06; verify against the
source files named in each section, because the lists change.

## The four layers (most to least restrictive)

A tool call only works if it passes every layer. Work out which layer is blocking before changing anything.

| # | Layer | Who sets it | Can the UI undo it? | Where it lives |
| --- | --- | --- | --- | --- |
| 1 | **Company gate** (shared vs. private company) | Code | No | `companyVisibility` on an app definition (`packages/shared/src/app-definitions/*.json`), enforced by `server/src/services/app-company-visibility.ts` |
| 2 | **Hard-disabled** (catalog status `disabled`) | Code, at catalog refresh | No ("Disabled actions cannot be enabled", `tool-access.ts`) | `isGmailToolPermanentlyBlocked`, `isGoogleWorkspaceToolAllowed`, provider block lists in `server/src/services/tool-access.ts` |
| 3 | **Quarantined** (catalog status `quarantined`) | Code, for any tool not on a reviewed list | Yes: the connection owner reviews and enables it in Permissions | `quarantineNewEntries` plus the reviewed lists in `server/src/services/default-mcp-spec.ts` |
| 4 | **Per-agent install and profile** | Owner / board, in the UI | This layer *is* the UI | Permissions UI; `default-mcp-spec.ts` `defaultEnabled` for the starting state |

Rule of thumb: code decides what is *possible* (layers 1 and 2), the reviewed lists decide what *starts on* (layer 3),
and people decide what is *actually on for an agent* (layer 4).

## Layer 1: shared vs. private companies

- Every company has `companies.visibility` of `private` or `shared`. It is write-once. NULL means "not yet classified".
  Classification and the one-way rules (`private` to `shared` is never done) are in
  [DEFAULT-MCP-SPEC.md](./DEFAULT-MCP-SPEC.md), "Company visibility backfill".
- **App-level exclusion.** An app definition can declare `"companyVisibility": ["private"]`. That list is an allowlist:
  a NULL company fails closed, and users see "<App> is only available in private companies." Today only Granola
  (`granola.json`) declares it. API error code: `app_unavailable_for_shared_company`.
- **Do not** use `isCompanyVisibilityShared` (`default-mcp-setup.ts`) for an exclusion. It treats NULL as private, which
  is the opposite of fail-closed. Use `isAppAvailableForCompanyVisibility`.
- **Shared companies get a different RH MCP path.** They get `rh-mcp-service`, a per-org service token with a scope-limited
  tool list (`RH_MCP_SERVICE_TOOLS_BY_SCOPE`), never the personal OAuth `rh-mcp`. It is created only for companies whose
  visibility is `shared` (`shared-org-rh-mcp.ts`, [DEFAULT-MCP-SPEC.md](./DEFAULT-MCP-SPEC.md) section "Shared-org rh-mcp").
- **Open item: RH Google MCP.** `rh-google-mcp` is an entry in `DEFAULT_MCP_SPEC`, not an app definition, and nothing in
  the code checks company visibility for it. It is a personal-only OAuth entry (each person connects their own Google
  account), which is why it behaves as private-only in practice, but "not in shared companies" is not enforced. If you
  need it enforced, add a visibility check to its seed/connect path (`default-mcp-oauth-seed.ts`); `companyVisibility`
  only applies to app definitions.

## Layer 2: hard-disabled tools

A hard-disabled tool is saved with status `disabled` on every catalog refresh and cannot be enabled from the UI.
Changing it needs a code change and a test.

- **Google-hosted Gmail connector** (`gmailmcp.googleapis.com`): `isGmailToolPermanentlyBlocked` blocks any tool whose
  name matches `send|trash|spam|delete|remove|destroy|execute|run`, and any label tool that is not a read. The one
  exception is `unlabel_thread` (archive). Tests: `server/src/services/gmail-tool-governance.test.ts`.
- **Google Workspace profiles**: `isGoogleWorkspaceToolAllowed` allows only the read tools in
  `GOOGLE_WORKSPACE_READ_TOOLS` (`tool-access.ts`) plus each profile's `writeTools`
  (`packages/shared/src/google-workspace-connectors.ts`). Everything else is `disabled`.
- **Railway**: `isRailwayToolBlocked`.
- **Not hard-disabled:** RH Google MCP (the self-hosted server). Nothing in code blocks its tools; they are only
  quarantined until reviewed (Layer 3). That is why `send_gmail_message` or `manage_drive_access` can be switched on there
  by an owner. If you want a tool to be impossible, it must be added to a hard block list, not just left off.

## Layer 3: what starts on (reviewed lists)

When a catalog is discovered, tools not on a reviewed list are `quarantined` until a person approves them.

| Connection | List | File | Applies when |
| --- | --- | --- | --- |
| RH Google MCP | `RH_GOOGLE_MCP_INITIAL_ACTIVE_TOOLS` (read tools plus `RH_GOOGLE_MCP_SAFE_WRITE_TOOLS`) | `default-mcp-spec.ts` | First consent of a **brand-new** personal instance only |
| RH MCP (personal) | `readCeiling` | `default-mcp-spec.ts` | Caps effective agent access; first consent auto-approves it |
| RH MCP (shared org) | `RH_MCP_SERVICE_REVIEWED_TOOLS` | `default-mcp-spec.ts` | Shared companies only |
| Comms board | `reviewedTools.allow` (version 2) | `default-mcp-spec.ts` | Template bootstrap |
| Argus review | `ARGUS_REVIEW_REVIEWED_TOOLS` | `default-mcp-spec.ts` | Template bootstrap |

Important details:

- The RH Google MCP list is **hand-built**. Do not derive it from the server's own `isReadOnly` flag: that flag marks 95
  of 121 tools read-only, including ones that change data (`manage_drive_access`, `modify_gmail_message_labels`,
  `modify_sheet_values`, `manage_event`, `run_script_function`, `export_doc_to_pdf`, `draft_gmail_message`).
- Widening the list does **not** retroactively turn tools on for an existing personal instance. A tool never seen before
  is quarantined on its next refresh, and the owner must enable it in Permissions. A reconnect does not change earlier
  choices. See the "Widening the ceiling" notes in [DEFAULT-MCP-SPEC.md](./DEFAULT-MCP-SPEC.md).
- Bump `version` on a list when you change it so the change is traceable.

## Layer 4: default on/off in the UI

- **App starts OFF per agent.** `defaultEnabled` on each entry in `DEFAULT_MCP_SPEC` (`default-mcp-spec.ts`). `false`
  records the app but creates no install row. `rh-google-mcp` and `rh-mcp` are `false`; `rh-mcp-service` and the
  dedicated comms board are on.
- **Feature flag.** The whole default-MCP feature is off unless `PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED=true`. Rollout scope
  is `PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS` (unset means every company; malformed means no company).
- **Install rule.** For managed agents, an app is ON only with an explicit per-agent install row. A company-wide install,
  profile or organization grant does not turn it on. `rh-google-mcp` has `installOnExistingAgentsOnConnect: true`, so
  when an owner first connects, it is installed on the live agents that owner created. Agents created by others, and
  agents created later, start with it off.
- **Per-tool toggles.** The owner's Permissions screen changes which `active` catalog tools are in the agent's profile.
  Recommended UI defaults for a gallery app come from `recommendedDefaultsForApp` (`tool-access.ts`).
- **Agent-level Paperclip permissions** (create agents, manage tools, and so on) are a separate system. See
  [agent-permission-defaults.md](../agent-permission-defaults.md).

## Procedures

### A. Let agents use a tool on RH Google MCP (for example email labels)
1. Confirm the OAuth scope exists on the consent: labels need `gmail.modify`. Tool to scope map: `@require_google_service`
   decorators in `rh-claude-plugins/google_workspace_mcp/gmail/gmail_tools.py` and `auth/scopes.py`.
2. Add the tool name to `RH_GOOGLE_MCP_INITIAL_ACTIVE_TOOLS` so new personal instances start with it on, and bump the
   list version if one is recorded. Put low-risk writes in `RH_GOOGLE_MCP_SAFE_WRITE_TOOLS`, and add dangerous tools to the `DANGEROUS` guard in `default-mcp-spec.test.ts` instead.
3. For existing instances, the owner enables it under Permissions (it will be quarantined). Do not expect a deploy alone
   to switch it on.
4. For the self-provisioned per-agent profile (`scripts/mcp-targets.json` in the `rh-paperclip` repo), add the tool to the
   agent's `allow["rh-google-mcp"]` list and add the scope to `oauthScopes`; the mailbox owner must redo OAuth consent
   in their own board session (a board API key cannot).
5. Add or update tests under `server/src/__tests__/default-mcp-*.test.ts`.

### B. Make a tool impossible (hard-disable)
Add it to the relevant block list (Layer 2) with a test. Leaving it unlisted or off in the UI is not enough, because an
owner can still enable a quarantined tool.

### C. Exclude an app from shared companies
Add `"companyVisibility": ["private"]` to the app's JSON in `packages/shared/src/app-definitions/`, gate server paths
with `isAppAvailableForCompanyVisibility`, and test both a shared and a NULL-visibility company (NULL must be refused).

### D. Turn something off for one private company
Use the Permissions UI (Layer 4). Do not edit code for a per-company choice.

## Risk grouping for RH Google MCP tools

The rule (set 2026-11-06, reviewed again 2026-11-18): off only for real danger, which means sending, deleting something
that cannot be recovered, sharing or publishing, reaching other people, and running or changing code. Dangerous tools
stay off by default and owners can enable them in the UI.

- **Off by default, enable only with a reason:**
  - Sending: `send_gmail_message`, `send_message` (Chat), `send_approved_email` (agents no longer send mail, TECH-8951).
  - Deleting, or deleting through an argument: `update_drive_file` (`trashed`, and it changes sharing),
    `delete_script_project`, `delete_doc_tab`, `manage_gmail_label`,
    `manage_task`, `manage_task_list`, `manage_contact`, `manage_contacts_batch`, `manage_contact_group`.
  - Sharing and publishing: `manage_drive_access`, `set_drive_file_permissions`, `set_publish_settings`,
    `get_drive_shareable_link`, `manage_calendar` (who a calendar is shared with).
  - Reaching other people: `manage_event`, `respond_to_event`, `create_event_with_zoom`, `manage_gmail_filter`
    (auto-forward or auto-delete).
  - Apps Script execution or change: `run_script_function`, `create_script_project`, `update_script_content`,
    `manage_deployment`, `create_version`, `manage_script_content` (rewrites code that later runs under the user's
    authorization), `manage_script_trigger` (runs a helper through the Execution API), `manage_script_project`
    (create or delete a project).
- **On at first connect (`RH_GOOGLE_MCP_SAFE_WRITE_TOOLS`):** `draft_gmail_message`, Gmail label tagging
  (`modify_gmail_message_labels`, `batch_modify_gmail_message_labels`), Docs, Sheets, Slides and Forms edit and create
  tools, Drive file writes (`create_drive_file`, `copy_drive_file`, `export_doc_to_pdf`, ...), and
  comment tools. Added 2026-11-18 (the 24 tools that arrived with workspace-mcp 2.4.1, none reviewed before):
  `draft_gmail_with_attachments`, `append_table_rows`, `import_to_google_sheets`, `import_to_google_slides`,
  `manage_script_version`, `manage_focus_time`, `manage_out_of_office`, and the Docs/Sheets structure tools
  `manage_doc_tab`, `manage_sheet_tab`, `resize_sheet_dimensions`, `manage_named_range`, `move_sheet_rows`. Their
  deletes are recoverable from Google version history, and the batch edit tools already on can do the same or more.
  The matching read tools (`list_sheet_tables`, `get_drive_file_text`, `get_gmail_attachment_text`,
  `render_page_to_image`, `get_script_activity`, `get_script_version`, `list_script_deployments`) are on too.
- **Known trade-off:** the label tools need `gmail.modify`, which also lets a call add the `TRASH` or `SPAM` label, so
  they are not strictly "tags only". They are on so agents can tag mail.

## Verify

- Unit tests: `pnpm --filter @paperclipai/server vitest run default-mcp gmail-tool-governance generic-mcp-connection`
  (adjust to the repo's test command). `generic-mcp-connection` holds the end-to-end first-consent test and needs
  embedded Postgres.
- In the UI, open the connection's Permissions page and confirm each tool shows the expected state: Active, Needs
  review (quarantined), or Disabled (hard-blocked, no toggle).
