# Google Workspace connector: code fixes before submission

Started November 17, 2026. Temporary working plan; delete it once the items
land. It covers section 2 of the
[production checklist](2026-11-17-google-workspace-production-checklist.md).

Based on a read of master at `56654adecd`. Items marked **confirmed** were seen
in the code. Items marked **to check** are suspected gaps that need a look
before any change. Nothing here has been implemented.

Each fix is its own pull request with a failing test first. Work that changes
what the Cloud broker accepts ships broker first, then the app.

## Order

| # | Fix | Size | Blocks submission |
| --- | --- | --- | --- |
| 1 | Data-use disclosure in the picker | Small | Yes |
| 2 | Lock the managed scope set to 14 | Small to medium | Yes |
| 3 | Take `gmail.modify` off the Paperclip-managed client | Small | Yes |
| 4 | Confirm injection screening on Google results | Check, then small | Yes |
| 5 | Revoke at Google on last disconnect | Medium | Likely |
| 6 | Retention and deletion of Google content | Audit, then unknown | Yes |
| 7 | Security scan findings | Unknown | Yes (assessment) |
| 8 | Remove the experimental gate | Small | No, release step |
| 9 | REST-backed tool set | Large | Yes |
| 10 | Scope cleanup across code, Cloud and Console | Medium | Yes |

## 1. Data-use disclosure in the picker

**Confirmed gap.** `ServicePicker` in
`ui/src/features/connections/GoogleWorkspaceServices.tsx` shows three service
rows and Cancel / Continue. Its only description is screen-reader text. Google
requires a disclosure inside the app, immediately before consent, that says
what data is accessed and how it is used and shared; a privacy-policy link
alone does not count.

- Add a short visible block above the footer, built from the current selection:
  what Paperclip will be able to read and change for the chosen services, that
  agents send this content to the model provider configured for the workspace
  to do the tasks they are given, that it is not used to train general models,
  and where results are stored.
- Link the privacy policy and the Limited Use statement.
- The copy changes with the selection (read only versus read & write; Gmail
  write says "create drafts", never "send").
- Show it for new setup and for reconnect, in both the Apps flow and the
  task-hosted flow (both use `GoogleWorkspaceServicesDialog`).
- Tests in `GoogleWorkspaceServices.test.tsx`: disclosure present for each
  selection, absent wording for unselected services, links present.
- Update the Storybook story under
  `ui/storybook/stories/connection-setup/google-workspace-services.stories.tsx`.
- Follow `DESIGN.md` (tokens only, form footer rules).

Link to <https://paperclip.ing/privacy> (section 4.1 holds the Limited Use
statement). The disclosure wording must agree with that policy, so the policy
edits listed in the working memory land first or together. Dotta signs off
the wording.

## 2. Lock the managed scope set to 14

**Confirmed.** The selector derives scopes from
`GOOGLE_WORKSPACE_SERVICE_GROUPS` in
`packages/shared/src/google-workspace-connectors.ts`, which yields 14 scopes
across all modes. But the `workspace.all` profile is still the 21-scope legacy
union (Chat, Contacts, Directory, profile and `calendar.readonly` included),
and `isGoogleWorkspaceScopeGrant` accepts any subset of those 21.

- Add a test that the union of every selectable combination equals an explicit
  list of the 14 scopes, so a new scope cannot slip in unnoticed. Today's tests
  pin 9 (default) and 21 (legacy) only.
- Add a server test that an authorization request for the unified connection
  carrying any scope outside the 14 is rejected, for both the managed and the
  customer-owned path.
- Narrow `isGoogleWorkspaceScopeGrant` for the unified connection to the 14.
  **To check first:** whether saved grants or the broker's sealed envelopes
  depend on the 21-scope definition (the code comment says the union is kept
  stable for the broker contract). If so, add a separate 14-scope constant and
  leave the legacy definition for old grants.
- Companion change in the Cloud broker registry so the production client
  cannot be asked for the other 7. Broker first, then app.

## 3. Take `gmail.modify` off the Paperclip-managed client

**Confirmed.** `packages/shared/src/app-definitions/gmail.json` has a
`paperclip-archive` method ("Connect with Paperclip", profile `gmail.archive`)
that requests `gmail.modify`, a restricted scope that is not in the
submission. If the production broker ever enables that profile, the verified
client requests an undeclared restricted scope.

- Remove the `paperclip-archive` method, or gate it so it can never use the
  Paperclip-managed client. Keep `customer-archive-oauth` (the customer's own
  Google client is outside our verification).
- Keep `server/src/services/gmail-archive-tool-policy.ts` working for saved
  connections.
- **To check:** whether any saved connection uses `paperclip-archive`, and
  whether the production or staging broker has `gmail.archive` enabled.
- Do the same inventory for every other "Connect with Paperclip" Google method
  in `packages/shared/src/app-definitions/google-*.json` and `gmail.json`
  (Chat, People, Workspace Search and the per-service cards): each one that can
  reach the managed client either stays within the 14 scopes or loses its
  managed method.
- Test: no app definition with the managed strategy lists a scope outside the 14.

## 4. Confirm injection screening on Google results

**To check.** Tool-result screening exists
(`doc/prompt-injection-prevention.md`): built-in detection is always on, and a
model check is optional per company. Not yet confirmed that every Google
Workspace tool result passes through it, in particular email bodies and file
content fetched through the unified connection.

- Trace a `gmail__get_message` and a `drive__read_file_content` call from the
  gateway to the runner and confirm the guard runs on the result.
- Add a test with an injected instruction inside an email body and inside a
  document, expecting `prompt_injection_blocked`.
- Fix any path that skips the guard.
- Write two paragraphs for the submission describing what the screening does
  and does not protect against.

## 5. Revoke at Google on last disconnect

**Confirmed behavior, likely gap.** Removing a managed Google connection is
local only, because Google's revoke ends every grant for that user on the
client and would break their other Google connections
(`doc/connections/GOOGLE-WORKSPACE.md`). With one unified connection that
reasoning mostly goes away, and reviewers expect disconnect to end access.

- When a user removes their last grant on the Paperclip-managed Google client,
  call Google's revoke endpoint through the broker.
- If other grants for the same Google account remain, stay local and say so in
  the confirmation text.
- Tests: last grant revokes; one of two does not; a revoke failure still
  removes the local credential and reports the failure.
- Needs a broker endpoint; broker first.

## 6. Retention and deletion of Google content

**To check.** Email and file content returned by tools is stored in task
comments, run history, tool results and attachments. Disconnecting does not
delete any of it. Google requires that users can delete their data and that we
document how.

- Inventory where Google tool results are stored and for how long.
- Confirm that deleting a task or a workspace removes them.
- Decide with the privacy owner whether an explicit "delete data from this
  connection" action is needed. If the answer is yes, that becomes its own plan.
- Write the user help page either way.

## 7. Security scan findings

- Run the static and dynamic scans used for the CASA self-assessment against
  the server, the broker and the reviewer instance.
- Triage findings into fix now, accepted with reason, and not applicable.
- One pull request per finding class.

## 8. Remove the experimental gate (release step, last)

**Confirmed.** `enableGoogleWorkspaceConnector` defaults to off
(`packages/shared/src/validators/instance.ts`, set on the app definition in
`google-workspace.json`, enforced in `tool-gateway.ts`,
`connection-intents.ts` and `setup-policy.ts`).

- After Google approves: default it on, or remove the key and its checks.
- Update `doc/connections/GOOGLE-WORKSPACE.md` and the release notes.
- Decide what happens to the aggregator Google apps that appear while the gate
  is off.

## 9. REST-backed tool set (chosen November 17)

Decision: launch on our own tools over Google's REST APIs, designed so we can
switch to Google's hosted MCP servers later, kept in one folder so it can be
deleted cleanly. This is a design to confirm against the dispatch code before
building; the dispatch path has not been traced yet.

### The seam

Today the unified connection sends each tool call, with the user's Google
access token, to a Google MCP endpoint chosen by a closed registry in
`packages/shared/src/google-workspace-connectors.ts` (`serverUrl` per service).
Everything above that point (picker, scopes, grant checks, allowlist, approval,
audit, injection screening) only knows tool names and required scopes.

So the replacement is **an MCP server of our own that exposes the same tools
as Google's**: same names, same input fields, same result shape, backed by
REST. The rest of the system keeps speaking MCP to it and cannot tell the
difference. Switching to Google's MCP later is changing which endpoint the
registry returns.

### Layout

One new package, following `packages/google-sheets-mcp-server`:

```
packages/google-workspace-rest-tools/
  src/
    index.ts            the only export: create the server / handle a call
    server.ts           MCP wiring (list tools, call tool); thin
    google-http.ts      the one place that calls googleapis.com: auth header,
                        errors mapped to MCP errors, retry rules
    gmail/              one file per tool: args in, REST request out,
    drive/              REST response in, MCP result out (pure functions)
    docs/
    sheets/
    slides/
    calendar/
    schemas/            tool definitions copied from Google's MCP reference
```

### Boundary rules

- **One switch.** The registry gains a transport choice per service
  (`google_mcp` or `paperclip_rest`). That choice, plus registering the
  package, is the only Google-REST knowledge outside the folder.
- **No REST types leave the package.** Its public surface is MCP tool
  definitions and MCP results.
- **Nothing in the package knows about Paperclip.** No company, connection,
  grant, policy or audit code. It receives a tool name, arguments and an
  access token, and returns a result. Authorization, scope checks, approval,
  audit and injection screening stay with their current owners in the gateway.
- **It stores nothing.** No tokens, no content, no cache.
- **The allowlist stays where it is.** `toolScopes` in
  `google-workspace-connectors.ts` remains the single list of allowed tools;
  the package implements exactly that list, and a test fails if the two differ.
- **Removal test.** Deleting the folder and setting the switch to `google_mcp`
  leaves a build that passes. Add this as a checklist item for the removal PR.

### Parity

- Tool names and schemas come from Google's published MCP tool reference, not
  from our guess. A contract test compares our definitions with a recorded
  listing from Google's servers (we can record it on our enrolled internal
  account).
- Where REST cannot match an MCP tool's behavior exactly, write the difference
  in the package README rather than hiding it.

### Order of work

1. Trace the dispatch path and confirm the seam (in-process handler or a
   loopback HTTP endpoint; whichever the gateway already supports).
2. Package skeleton, `google-http.ts`, the switch, and Gmail `get_message`,
   `search_threads` and `create_draft`, end to end on the staging tester.
   The demo depends on Gmail.
3. Rest of Gmail, then Calendar, Drive, Docs, Sheets, Slides.
4. Contract and removal tests.

Tools to build (36): Gmail 9, Drive 8, Docs 2, Sheets 6, Slides 2, Calendar 9.

### To check

- Whether the gateway can call an in-process MCP handler or needs an address.
- Whether a Google client marked for AI agents may call the REST APIs.
- Each Cloud project needs the six REST APIs enabled.
- Speed: this sits in the tool-call path, so measure added time per call.

## 10. Scope cleanup across code, Cloud and Console

Decision (November 17): what we ask for, what the code accepts, what the
Cloud broker allows and what the Console declares must be the same 14 scopes.
Fixes 2 and 3 cover this repository. Also needed:

- Compare the broker's profile registry in `paperclip-cloud` with the 14 and
  remove or fence the rest for the Paperclip-managed client.
- Compare the Console declaration for both Google apps with the 14 (needs the
  project owner's sign-in).
- One table in the working memory showing all four side by side, kept current.

## Not code, but needed by these fixes

- Published privacy policy and Limited Use statement URLs (fix 1).
- Sign-off on disclosure wording (fix 1).
- Broker changes in the Cloud repository (fixes 2, 3, 5).
- Current broker profile settings for staging and production (fixes 2, 3).
