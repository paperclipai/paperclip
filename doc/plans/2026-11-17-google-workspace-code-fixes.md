# Google Workspace connector: code fixes before submission

Started November 17, 2026. Temporary working plan; delete it once the items
land. It covers section 2 of the
[production checklist](2026-11-17-google-workspace-production-checklist.md).

Based on a read of master at `56654adecd`. Items marked **confirmed** were seen
in the code. Items marked **to check** are suspected gaps that need a look
before any change. Fixes 1 to 4 and 6 landed on November 17. Fix 9 has every
tool built but no service switched on. Fix 10 is done in the app. Fixes 5, 7
and 8 are not started.

Each fix is its own pull request with a failing test first. For the scope
change in fix 2, the deploy order is app first, then broker (see fix 10).

## Order

| # | Fix | Size | Blocks submission | Status |
| --- | --- | --- | --- | --- |
| 1 | Data-use disclosure in the picker | Small | Yes | Done, [#21998](https://github.com/paperclipai/paperclip/pull/21998); removed Nov 24 by owner decision |
| 2 | Lock the managed scope set to 14 | Small to medium | Yes | Done in the app, [#22001](https://github.com/paperclipai/paperclip/pull/22001) |
| 3 | Take `gmail.modify` off the Paperclip-managed client | Small | Yes | Done, [#22001](https://github.com/paperclipai/paperclip/pull/22001) |
| 4 | Confirm injection screening on Google results | Check, then small | Yes | Done, [#21999](https://github.com/paperclipai/paperclip/pull/21999) |
| 5 | Revoke at Google on last disconnect | Medium | Likely | Not started |
| 6 | Retention and deletion of Google content | Audit, then unknown | Yes | Done with limits, [#22010](https://github.com/paperclipai/paperclip/pull/22010) |
| 7 | Security scan findings | Unknown | Yes (assessment) | Not started |
| 8 | Remove the experimental gate | Small | No, release step | Not started |
| 9 | REST-backed tool set | Large | Yes | All 36 tools and the switch merged; none switched on |
| 10 | Scope cleanup across code, Cloud and Console | Medium | Yes | App done; broker and Console open |

## 1. Data-use disclosure in the picker

**Done** (Nov 17, [#21998](https://github.com/paperclipai/paperclip/pull/21998)).
Every Google Workspace sign-in start now goes through the picker, including
four sign-in paths on the app page. The Gmail read & write line says Google's
screen also mentions sending and that Paperclip does not send. The plan below
is kept for reference.

**Removed** (Nov 24) by owner decision. The picker keeps only the privacy
policy link, which names Google's Limited Use requirements.

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

**Done in the app** (Nov 17, [#22001](https://github.com/paperclipai/paperclip/pull/22001)).
`GOOGLE_WORKSPACE_SUBMITTED_SCOPES` is the hand-written list of 14 and
`workspace.all` uses it. Requests outside the 14 are rejected; scopes Google
reports on a saved grant are capped to the 14 instead of failing it. The
broker change is in fix 10. The plan below is kept for reference.

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
  cannot be asked for the other 7. App first, then broker (fix 10).

## 3. Take `gmail.modify` off the Paperclip-managed client

**Done** (Nov 17, [#22001](https://github.com/paperclipai/paperclip/pull/22001)).
Gmail archive, Chat, People and Workspace Search managed methods are no longer
offered for new setup or reconnect; saved connections keep refreshing and
running. The broker has no `gmail.archive` profile. The plan below is kept for
reference.

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

**Done** (Nov 17, [#21999](https://github.com/paperclipai/paperclip/pull/21999)).
Every path was traced and tested. The one unscreened path, resource reads
through a named gateway, is now screened for every connector. What screening
does and does not cover is in `doc/prompt-injection-prevention.md`. The plan
below is kept for reference.

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

**Done, with limits** (Nov 17, [#22010](https://github.com/paperclipai/paperclip/pull/22010)).
Any connection's page has "Delete data", and removing a connection offers the
same. It clears previews, approval cards, results passed to later runs, app
views and the whole transcript of each settled run that used the connection.
It keeps call records without content. Deleting a task or a company runs
the same cleanup, including run logs and saved files in storage. Limits:
content agents wrote into tasks stays until the task is deleted; "Delete data"
skips runs in progress. The help page is
`docs/guides/board-operator/deleting-connection-data.md`. The inventory is in
the working memory under "Where Google content is kept". Revoking at Google is
fix 5. The plan below is kept for reference.

**To check.** Email and file content returned by tools is stored in task
comments, run history, tool results and attachments. Disconnecting does not
delete any of it. Google requires that users can delete their data and that we
document how.

Audit findings (Nov 17, as reported) are in the working memory under "Where
Google content is kept". The planned fix is a "delete data read through this
connection" action.

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
deleted cleanly. Part 1 is
[#22000](https://github.com/paperclipai/paperclip/pull/22000) (merged Nov 17): the
folder and Gmail `get_message`, `search_threads` and `create_draft`. Its README
records the dispatch trace and the recommended in-process seam.

Status (Nov 17, night):

| Service | Implemented | Switched on | PRs |
| --- | --- | --- | --- |
| Gmail | 9 of 9 | No | [#22000](https://github.com/paperclipai/paperclip/pull/22000), [#22014](https://github.com/paperclipai/paperclip/pull/22014) |
| Calendar | 9 of 9 | No | [#22017](https://github.com/paperclipai/paperclip/pull/22017) |
| Drive | 8 of 8 | No | [#22028](https://github.com/paperclipai/paperclip/pull/22028) |
| Docs | 2 of 2 | No | [#22029](https://github.com/paperclipai/paperclip/pull/22029) |
| Sheets | 6 of 6 | No | [#22027](https://github.com/paperclipai/paperclip/pull/22027) |
| Slides | 2 of 2 | No | [#22029](https://github.com/paperclipai/paperclip/pull/22029) |

The per-service switch and in-process dispatch landed in
[#22016](https://github.com/paperclipai/paperclip/pull/22016). Every service is
still on Google's MCP. The gateway calls the REST tools in process, as the
trace in #22000 recommended. The gateway also sets the size limit for REST
results (999,885 bytes, matching what it accepts from Google's MCP servers);
see "Result size" in the folder README.

Remaining work:

- Refuse inserting an image by public web address in Docs and Slides before
  they are switched on (Google fetches an address the agent chose).
- Create the staging tester and run live acceptance there.
- Switch services to REST one at a time, each after its live test.
- Record a `tools/list` and sample answers from Google's servers for the
  contract test, and compare `read_doc` and `read_presentation` content.
- Check `copy_file` under `drive.file` on a file the app never opened.
- Removal test (step 4 below).

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

One folder inside the existing server, not a new package. No new dependency,
workspace or release change.

```
server/src/google-workspace-rest-tools/
  index.ts            the only entry point: create the server / handle a call
  server.ts           MCP wiring (list tools, call tool); thin
  google-http.ts      the one place that calls googleapis.com: auth header,
                      allowed hosts, errors mapped to MCP errors, retry rules
  tools.ts, tool.ts   the tool list and the shared tool shape
  errors.ts
  README.md           boundary rules, dispatch trace, differences from Google
  gmail/              one file per tool, plus schemas and helpers
  drive/              (later) args in, REST request out,
  docs/               REST response in, MCP result out
  sheets/
  slides/
  calendar/
```

### Boundary rules

- **One switch.** The registry gains a transport choice per service
  (`google_mcp` or `paperclip_rest`). That choice, plus registering the
  folder, is the only Google-REST knowledge outside the folder.
- **No REST types leave the folder.** Its public surface is MCP tool
  definitions and MCP results. A boundary test limits its imports to its own
  files, Node built-ins, the MCP SDK and `zod`.
- **Nothing in the folder knows about Paperclip.** No company, connection,
  grant, policy or audit code. It receives a tool name, arguments and an
  access token, and returns a result. Authorization, scope checks, approval,
  audit and injection screening stay with their current owners in the gateway.
- **It stores nothing.** No tokens, no content, no cache.
- **The allowlist stays where it is.** `toolScopes` in
  `google-workspace-connectors.ts` remains the single list of allowed tools;
  the folder implements exactly that list, and a test fails if the two differ.
- **Removal test.** Deleting the folder and setting the switch to `google_mcp`
  leaves a build that passes. Add this as a checklist item for the removal PR.

### Parity

- Tool names and schemas come from Google's published MCP tool reference, not
  from our guess. A contract test compares our definitions with a recorded
  listing from Google's servers (we can record it on our enrolled internal
  account).
- Where REST cannot match an MCP tool's behavior exactly, write the difference
  in the folder's README rather than hiding it.

### Order of work

1. Trace the dispatch path and confirm the seam. Traced in #22000's README:
   an in-process call, because the egress guard refuses a loopback address on
   public deployments.
2. Folder skeleton, `google-http.ts`, and Gmail `get_message`,
   `search_threads` and `create_draft` (#22000, merged). Then the switch, end to
   end on the staging tester. The demo depends on Gmail.
3. Rest of Gmail, then Calendar, Drive, Docs, Sheets, Slides (done Nov 17).
4. Contract and removal tests.

Tools to build (36): Gmail 9, Drive 8, Docs 2, Sheets 6, Slides 2, Calendar 9.

### To check

- Whether a Google client marked for AI agents may call the REST APIs.
- Each Cloud project needs the six REST APIs enabled.
- Speed: this sits in the tool-call path. Measured: the adapter adds about
  15 µs per call; the result size check adds about 5 µs for a 4 KB result.

### Lessons

- **Address parsing:** patching a split-on-commas parser case by case kept
  breaking (comments, groups, IPv6 literals); write one RFC 5322 tokenizer with
  table-driven tests from the start.
- **No new package:** the server is published, so a new package it depends on
  would also need publishing; a folder inside the server avoids that.

## 10. Scope cleanup across code, Cloud and Console

Decision (November 17): what we ask for, what the code accepts, what the
Cloud broker allows and what the Console declares must be the same 14 scopes.
Fixes 2 and 3 cover this repository and are done. Still needed in the Cloud
broker (`paperclip-cloud`, registry at `src/connections/providers.ts`, as
reported by the Nov 17 audit):

- Limit `workspace.all` to the 14.
- On refresh and claim, cap reported scopes to the 14 instead of failing, and
  keep accepting the old 21-scope refresh binding until older app versions are
  gone.
- Stop offering Chat, People and Search for new sessions on the verified
  client.
- Do not merge the branch that adds a Gmail archive profile.
- Deploy order: app first, then broker.

Also needed:

- Compare the Console declaration for both Google apps with the 14 (needs the
  project owner's sign-in).
- Keep the working memory's "Scopes" and "Cloud broker" sections current.

Read & write Calendar now also requests `calendar.events.freebusy` (Nov 17).
It is one of the 14 and the broker accepts any nonempty subset of
`workspace.all`, so neither the broker nor the Console needs a change for it.

## Not code, but needed by these fixes

- Published privacy policy and Limited Use statement URLs (fix 1).
- Sign-off on disclosure wording (fix 1).
- Broker changes in the Cloud repository (fixes 5 and 10).
- Current broker profile settings for staging and production (fixes 2, 3).
