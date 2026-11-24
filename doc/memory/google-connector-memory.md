# Google connector working memory

Temporary. Holds the decisions and details we keep needing while the built-in
Google Workspace connector goes through Google approval and into production.
Delete this file once the connector is approved and released.

This repository is public. Keep passwords, client IDs and secrets, project
numbers, review login codes and review correspondence out of this file; they
live in the private operator handoff.

Related: [production checklist](../plans/2026-11-17-google-workspace-production-checklist.md),
[code-fix plan](../plans/2026-11-17-google-workspace-code-fixes.md),
[connector doc](../connections/GOOGLE-WORKSPACE.md).

Last updated: November 23, 2026 (evening).

## Decisions

| Date | Decision | Detail |
| --- | --- | --- |
| Nov 17 | **Owner for everything is Dotta** | Submission, security, privacy and release. |
| Nov 17 | **Launch on our own tools over Google's REST APIs** | Google's hosted Workspace MCP servers are still Developer Preview and cannot be offered to the public. We build our own tool set for agents that have this connector. |
| Nov 17 | **The REST tool set must be swappable for Google's MCP later** | Same tool names, inputs and results as Google's MCP tools, so switching back is a change of endpoint, not a rewrite. |
| Nov 17 | **The REST tool set lives in its own folder** | Nothing Google-REST-specific leaks into shared code; removing it later means deleting the folder and flipping one registration. Follow the boundary-discipline principle and `rules/module-boundaries.mdc`. |
| Nov 17 | **No new npm packages** | The REST tool set is a folder inside the server, `server/src/google-workspace-rest-tools/`, not a new package. The server is published, so a new package in its dependencies would also have to be published. |
| Nov 17 | **Engineering test instance moves to staging** | Create `googletester.staging.paperclip.app`; staging is far easier to deploy to. |
| Nov 17 | **Scopes must line up everywhere** | What the picker asks for, what the code accepts, what the Cloud broker allows, and what the Google Console declares are the same 14 scopes. |
| Nov 17 | **Scope handling contract** | What we **request** is strict: a request with a scope outside the 14 is rejected. What Google **reports** on a saved grant is capped to the 14 and to the saved selection, and the grant keeps working. Only a grant with nothing inside the 14 (or no scope evidence at all) needs reconnecting. |
| Nov 17 | **Assessment prep starts before Google asks** | Run the scans and fix findings now; the formal assessment starts on Google's notice. |
| Nov 17 | **Agents that prepare PRs merge them** | On the coordinator's approval, once required checks pass and Greptile is 5/5. |
| Nov 17 | **Merges are gated on green CI and Greptile 5/5 only** | Not on the ponytail review bot. |
| Nov 17 | **`delete_event` never deletes a whole recurring series in this release** | A series ID is refused; the agent must pass one occurrence's ID. |
| Nov 17 | **A health probe may only use a request the granted scopes permit** | Each service lists cheap reads with the scopes that allow each; the probe uses the first one the grant allows. |
| Nov 17 | **Read & write Calendar also requests free/busy** | See "Scopes". |
| Nov 17 | **Tool labels must be truthful, even where Google's differ** | Every update tool is marked destructive: Calendar `update_event`, Docs `update_doc`, Slides `update_presentation`, Sheets `update_spreadsheet`. Google marks them non-destructive. Approval and confirmation follow our label. |
| Nov 17 | **Docs and Slides edits go through a closed list of request types** | Each request type is allowed or refused by name. A type not on the list, including one Google adds later, is refused and nothing is sent. |
| Nov 17 | **No tool may reach a file other than the one named** | Request types that read another file (smart-chip links, linked Sheets charts, imported slides, Drive audio and video) are refused. Image links on `drive.google.com` or `docs.google.com` are refused. Drive tools use only the file ID the caller passed. |
| Nov 17 | **Docs and Slides edits require the revision that was read** | `requiredRevisionId` is mandatory. If the file changed since the read, nothing is changed and the agent is told to read it again. |
| Nov 17 | **Sheet tabs and ranges may be deleted inside a spreadsheet** | Through `update_spreadsheet`, because the approver sees each request type (`deleteSheet`, `deleteDimension`, and so on). No tool deletes, creates or shares a whole spreadsheet. |
| Nov 17 | **Deleting a whole recurring series is refused** | Same rule as the `delete_event` decision above. |
| Nov 17 | **A service is switched to REST only after a live test on the staging tester** | One service at a time. |
| Nov 17 | **The gateway sets the REST result size limit** | The REST tools enforce the number the gateway passes: the gateway's MCP response limit less framing, 999,885 bytes. A result Google's MCP server could deliver is also delivered over REST. See the folder README's "Result size". |
| Nov 23 | **All six launch services switched to REST now** | Gmail, Drive, Docs, Sheets, Slides and Calendar are `paperclip_rest`. This replaces the Nov 17 "one service at a time after a live test" rule: live testing happens on the staging tester right after the switch deploys, and problems are fixed forward. Chat, People and Search stay on `google_mcp`. |
| Nov 23 | **Write actions default to "Allowed"** | No approval step by default, including actions labelled destructive. Operators can still set Ask first per action. |
| Nov 23 | **Images by public web address are allowed in Docs and Slides** | `insertInlineImage`, `replaceImage`, `createImage` and `replaceAllShapesWithImage` may use any public link. Links to Drive or Docs files stay refused (Nov 17 rule). Accepted risk: Google, not Paperclip, fetches the address, and Paperclip's own requests still go only to the allowed Google hosts. What remains is that an agent could put data in the address it chooses. Owner decision; do not restrict it. |
| Nov 23 | **Unconfirmed Google revocation is retried by the app, not Cloud** | When access must end and Google cannot be reached or confirm, the app keeps the token in `google_pending_revocations` and retries (1 minute up to 6 hours backoff, 30-day hard stop). Cloud still never stores provider tokens. Company deletion and a Cloud-removed instance queue the same way. The broker lets a removed instance sign a Google revoke (Cloud broker change, November 23). See [connector doc](../connections/GOOGLE-WORKSPACE.md), "Pending revocation". |
| Nov 23 | **Paperclip's Google sign-in is for Paperclip Cloud only** | Self-hosted instances bring their own Google OAuth client. Google's restricted-scope verification and security assessment cover Paperclip's infrastructure, so the broker does not give restricted-scope Google tokens to servers Paperclip does not run. The app hides the method on self-hosted instances and refuses to start it; the broker refuses it too (`PROVIDER_CLOUD_ONLY`). Google connections a self-hosted instance already has keep refreshing until a sunset date the owner will set on the broker; after it, the app asks the user to reconnect with their own Google client. |
| Nov 23 | **Google's reviewers get the staging tester** | `googletester.staging.paperclip.app`, on the separate Google app, pinned to a tested build. Not the production tester. |
| Nov 23 | **Security lab: TAC Security (recommended, not yet engaged)** | Google's discounted Tier 2 partner. Plan about $2,000 for year one including a retest. Confirm with a quote; Google assigns the tier. |
| Nov 23 | **A tool refuses an argument it does not know** | All 36 tools fail before any request to Google and name the accepted arguments. Found live: `list_threads` ignored a filter and returned unfiltered mail. |
| Nov 23 | **A cancelled or abandoned first sign-in leaves no connection** | Cancel removes the draft; a closed tab leaves a hidden draft that the next attempt reuses. Applies to every sign-in connector. |

## What has shipped

| PR | What it does | Merged commit |
| --- | --- | --- |
| [#21996](https://github.com/paperclipai/paperclip/pull/21996) | Plan docs: this file, the production checklist and the code-fix plan. | `12cb18e17d` |
| [#21998](https://github.com/paperclipai/paperclip/pull/21998) | Data-use disclosure in the service picker, shown just before Google consent. Every Google Workspace sign-in start goes through the picker, including four sign-in paths on the app page (Reconnect, Connect as me, Connect organization identity, dedicated-agent connect). The Gmail read & write line says Google's screen also mentions sending and that Paperclip does not send. | `b124ad0674` |
| [#21999](https://github.com/paperclipai/paperclip/pull/21999) | Prompt-injection screening now also covers resource reads through a named gateway, the one path that was not screened. Applies to every connector, not only Google. | `65eac24876` |
| [#22001](https://github.com/paperclipai/paperclip/pull/22001) | Scope lock. `GOOGLE_WORKSPACE_SUBMITTED_SCOPES` is the hand-written list of 14, and `workspace.all` uses it. Paperclip-managed Google methods outside the 14 (Gmail archive, Chat, People, Workspace Search) are no longer offered for new setup or reconnect through Paperclip's Google app; saved ones keep refreshing and running. | `66ac5d7aa0` |
| [#22000](https://github.com/paperclipai/paperclip/pull/22000) | REST tool set part 1: the folder `server/src/google-workspace-rest-tools/` with Gmail `get_message`, `search_threads` and `create_draft`. Nothing calls it yet; the switch comes in a later PR. | `a29658b5b7` |
| [#22010](https://github.com/paperclipai/paperclip/pull/22010) | Users can delete the data Paperclip stored from a connection's tool calls: "Delete data" on the connection's page, or a checkbox when removing it. Live for every connector, not only Google. Help page: `docs/guides/board-operator/deleting-connection-data.md`. | `d1b5cfe038` |
| [#22017](https://github.com/paperclipai/paperclip/pull/22017) | Nine Calendar tools in the REST tool set (Calendar 9 of 9). | `c41ca4a992` |
| [#22016](https://github.com/paperclipai/paperclip/pull/22016) | Per-service transport switch (`GOOGLE_WORKSPACE_TOOL_TRANSPORT`) and in-process dispatch to the REST tools. Every service is still on Google's MCP. Discovery and health run a scope-aware probe for a service on REST. | `c652c813bc` |
| [#22014](https://github.com/paperclipai/paperclip/pull/22014) | The remaining six Gmail read tools in the REST tool set (Gmail 9 of 9). | `1d3b4201e3` |
| [#22026](https://github.com/paperclipai/paperclip/pull/22026) | Read & write Calendar also requests `calendar.events.freebusy`, and the planning docs were brought up to date. | `7f1f0eef67` |
| [#22027](https://github.com/paperclipai/paperclip/pull/22027) | Six Sheets tools in the REST tool set (Sheets 6 of 6). | `c366a606b1` |
| [#22029](https://github.com/paperclipai/paperclip/pull/22029) | Docs and Slides tools in the REST tool set (Docs 2 of 2, Slides 2 of 2). Also marks Calendar `update_event` destructive. | `f61b919701` |
| [#22028](https://github.com/paperclipai/paperclip/pull/22028) | Eight Drive tools in the REST tool set (Drive 8 of 8). Also limits the Gmail host to its API path prefix (before, any path was accepted there) and requires a path prefix for every allowed host. | `ceaf574421` |

The REST tool set covers all 36 actions, and all six services are switched to it.

### REST tools status

| Service | Implemented | Switched on |
| --- | --- | --- |
| Gmail | 9 of 9 | Yes (Nov 23) |
| Calendar | 9 of 9 | Yes (Nov 23) |
| Drive | 8 of 8 | Yes (Nov 23) |
| Docs | 2 of 2 | Yes (Nov 23) |
| Sheets | 6 of 6 | Yes (Nov 23) |
| Slides | 2 of 2 | Yes (Nov 23) |

"Switched on" means the service is `paperclip_rest` in
`GOOGLE_WORKSPACE_TOOL_TRANSPORT`. Chat, People and Search stay `google_mcp`.

### Known differences from Google's tools

From the folder README (`server/src/google-workspace-rest-tools/README.md`).

| Service | Difference |
| --- | --- |
| Gmail | A reply draft is threaded but does not quote the original message. |
| Gmail | `get_draft`, `list_threads` and `search_messages` are not in Google's reference; their inputs and results are inferred from sibling tools. |
| Docs | The format of `read_doc`'s `content` has not been compared with an answer from Google's server. |
| Sheets | Whether Google's `get_values` returns formatted values and its `update_values` writes raw values is inferred, not verified. |
| Sheets | `get_spreadsheet` refuses `commentsIncluded: true`, and `update_spreadsheet` refuses comment requests: comments are not in the Sheets API. |
| Drive | `read_file_content` cannot extract text from PDF, Office or image files; they return `textFormattingNotSupported`. |
| Drive | Whether `copy_file` under `drive.file` can copy a file the app never created or opened is not verified. |

## Still open

- **Reviewer sign-in with the real review code.** The login is switched on
  and the review code exists, but the code has not been given to Google's
  reviewers and nobody has signed in with it yet. Only the owner holds it.
  This test also decides whether the reviewer's `member` role can add a
  Google connection or must be raised.
- **Disconnect and "Delete data" on the REST build.** Verified on the
  earlier build only.
- **Company deletion race.** A late activity entry can fail a company
  delete with a foreign-key error (seen once in CI on Nov 23). A fix is in
  review.
- **Instance removal cleanup** starts only when an instance admin opens the
  Cloud connection status page.
- **Sunset for self-hosted managed Google grants.** None is set. Count the
  grants first.
- **Google Console declaration.** The app under review still declares six
  scopes outside the 14: three Chat scopes, Contacts, Directory and
  `calendar.readonly`. Data access is "under review"; branding is verified.
  Change the declaration at submission, not before.
- **Three Gmail tools are inferred.** Google's MCP reference does not list
  `get_draft`, `list_threads` and `search_messages`; their schemas copy the
  sibling tools (#22014).
- **Privacy policy.** paperclipai/paperclip-website PR 197 merged on
  November 17 and the page shows "Last updated: November 17, 2026". Its
  no-training promise is narrower than before: it now covers only the model
  providers Paperclip selects and configures. That needs legal review; it is
  not required for Google approval. Whether it covers the OpenRouter model
  used by the optional injection-screening check is not confirmed (see
  "Privacy policy").
- **Lockfile on master.** `pnpm-lock.yaml` is behind `server/package.json`
  (`posthog-node` is missing), so a frozen install fails. Checked November 17
  at `ceaf574421`.
- **The "no review correspondence" rule.** Narrow it or keep it (see "Google
  review history").

## Next steps

1. Owner signs in as the reviewer on the staging tester; then test connect,
   an agent task, disconnect and "Delete data" as the reviewer.
2. Deploy to production on the owner's go: app first, then broker. The
   production GitHub Environment already has the reviewer login switch set
   to on (November 23), so no action is needed there. Without that switch,
   a production deploy would turn the production tester's reviewer login
   off.
3. Get a quote from the security lab.
4. Record the demo video and prepare the reply to Google.
5. Update the Console declaration to the 14 when submitting.

## Environments

| Name | Address | Notes |
| --- | --- | --- |
| Earlier tester | `googletester.paperclip.app` (company prefix `GOO`) | On **production**. Used for earlier tests. Hard to deploy to; do not build on it further. |
| Staging tester | `googletester.staging.paperclip.app` (company prefix `GOO`) | **Created November 18** on staging. Engineering qualification, and **the instance Google's reviewers get** (decided Nov 23). State below. |
| Test 02 | In the private handoff | Staging stack used for the October proof. Holds Dotta's own Gmail grant, so not for reviewers. |

Staging tester state (November 23):

- Organization slug `googletester`; the stack id is in staging fleet admin.
  Agent `Workspace Tester` runs OpenCode on DeepSeek V4.1 Flash 1017 through
  a company OpenRouter connection (a dedicated key with a spending limit).
- `enableGoogleWorkspaceConnector` is on through a fleet-admin override.
- **Pinned** (user managed) in fleet admin, so staging-wide releases skip it.
  Deploy to it directly with the Cloud repository's deploy-stack command.
  Broker changes on staging still reach it. Before the pin it followed fleet
  releases, which is why its build changed without a deploy.
- **On the separate Google app.** That app is External, In Production, with
  the six REST APIs enabled and the staging broker callback on its one web
  client. The consent screen names the app by its domain and shows one
  unticked box per permission. The staging environment lists the tester's
  stack for the alternate client, for the Workspace group only.
- Never set the alternate stack list before its client secret exists: the
  Google bootstrap step then fails and blocks every staging deploy.
- **Reviewer login is switched on, not yet handed over.** The deploy owns
  the switch (`CLOUD_HARNESS_REVIEWER_LOGIN_ENABLED` in the GitHub
  Environment). The reviewer account is a `member` of the workspace. A
  wrong review code is refused. Sign-in with the real review code is not
  tested (see "Still open").

Passed live on the tester, on REST against real Google (November 23):

- All 36 actions: Gmail (search, read, labels, drafts, list with a filter,
  create and read a draft), Drive (create, search, metadata, read, copy,
  recent), Docs (create, read, insert text, insert an image by link),
  Sheets (create, write, read, add a row, metadata), Slides (create, read,
  add a text box), Calendar (list, create, read, update, search, suggest a
  time, delete). Two agent runs, 41 steps. The first run had one failure
  (`list_threads`, below); after the fix every step passed.
- The connection survived the switch from Google's MCP servers with no
  reconnect, and a token refresh worked after the broker began binding
  grants to their instance.
- Choosing only Gmail read-only requests one scope; all read & write
  requests ten.
- An unknown tool argument is refused with the accepted arguments named.
- Cancelling a sign-in leaves one connection and nothing needing attention.
- Review, Permissions and Activity show readable action names and no ids.

Checked on the build before the REST switch only (test again on REST):

- Disconnect ends access at Google (the account's linked-apps list lost the
  entry), and reconnect works.

Left in the owner's Google account by the tests: five files named
"Paperclip QA 1123 …" and three unsent test drafts.

Found while testing, and fixed:

- `list_threads` ignored a filter it did not know (fixed, see "Decisions").
- A cancelled sign-in left a second connection marked "Finish setup".
- The Activity feed showed gateway tool names with part of the connection id.

Reviewer login: Google's reviewers could not use our normal sign-in, so the
tester has a separate sign-in page with **a review code** (eight digits), for
one dedicated reviewer account. The production tester got one in September.
The staging tester has its own, created November 23. A review code goes to
the reviewers only through the review channel.

## Google apps (Cloud projects)

| App | Purpose | State |
| --- | --- | --- |
| Original production app | The one under Google verification | It was released to more than 100 users while unverified and hit Google's 100-user cap. **Nobody new can sign in or sign up with it** until it is verified. |
| New app for us and the tester | Created so we and Google's reviewers can sign in at all | Separate Cloud project, set to In Production. Google asked for exactly this in its October 7 message. The reviewer environment must use this app's client. |

- The client labelled "managed staging" belongs to the original production
  app, despite the name. A flow that used it does not satisfy Google's
  separate-project request.
- Verification is of the original production app; the new app only gives
  reviewers a way in.
- With the REST transport, each project needs the Gmail, Drive, Docs, Sheets,
  Slides and Calendar APIs enabled, not the MCP APIs.

## Scopes

This is the one copy of the scope table. Other docs link here.

One connection, three groups, **14 scopes** across all modes (10 for the
default all-read-and-write selection, 8 for all read-only). Prefix:
`https://www.googleapis.com/auth/`. In code the list is
`GOOGLE_WORKSPACE_SUBMITTED_SCOPES` in
`packages/shared/src/google-workspace-connectors.ts`.

| Group | Read only | Read & write |
| --- | --- | --- |
| Gmail | `gmail.readonly` | `gmail.readonly`, `gmail.compose` |
| Drive, Docs, Sheets, Slides | `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly` | `drive.readonly`, `drive.file`, `documents`, `spreadsheets`, `presentations` |
| Calendar | `calendar.calendarlist.readonly`, `calendar.events.readonly`, `calendar.events.freebusy` | `calendar.calendarlist.readonly`, `calendar.events`, `calendar.events.freebusy` |

- **Restricted (trigger the security assessment):** `gmail.readonly`,
  `gmail.compose`, `drive.readonly`.
- **Gmail write means drafts only.** `gmail.compose` would let an app send;
  our tool list has no send action. Never say the scope itself prevents sending.
- **Out of scope:** Chat, Contacts, Directory, cross-service Search. Not in the
  picker, the request, the tools, the docs or the submission.
- **Read & write Calendar asks for free/busy** (Nov 17, [#22026](https://github.com/paperclipai/paperclip/pull/22026)). Google's
  REST `freeBusy.query` accepts only `calendar.readonly`, `calendar`,
  `calendar.events.freebusy` and `calendar.freebusy`, not `calendar.events`
  (<https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query>).
  Google's MCP `suggest_time` does accept `calendar.events`. So read & write
  Calendar now also requests `calendar.events.freebusy`, already one of the
  14. The per-service `calendar.write` profile keeps its two scopes, because
  the broker matches legacy profiles by exact scope set. Grants made before
  this change still count as read & write and keep `suggest_time`; on REST it
  falls back to reading attendees' events and names anyone it cannot read.
  Nothing prompts them to reconnect; choosing read & write Calendar again in
  the picker asks for the new scope.
- Target: nothing outside this table is requested, declared in the Console,
  or shown in the demo. The app side is done; the broker and Console are not
  (below).

Known mismatches to clean up (after #22001 the app side matches the 14):

- The Cloud broker still accepts the 21-scope legacy union for `workspace.all`.
- Production still enables the legacy Chat, People and Workspace Search
  profiles on our Google client. The app no longer offers them for new setup.
- The Google Console declaration has not been compared with the 14.

## Cloud broker (paperclip-cloud)

First reported by a read-only audit on November 17. The changes listed below
were then built and merged on November 17 and 18. They are live on **staging
only**; production still runs the old broker.

- The profile registry is at `src/connections/providers.ts`.
- One Google client per environment, shared by all profile groups. Staging's
  client differs from production's.
- `workspace.all` is enabled on staging only.
- There is no `gmail.archive` profile.
- Revocation is on for Google profiles, with a ledger of provider grants.
- A per-stack alternate Google client exists (for the tester). It is chosen
  only from the enrolled stack id.
- The scoped reviewer login (review code) allows the production and the staging
  tester hosts.

Changes made in the broker (staging):

| Change | Why |
| --- | --- |
| Limit `workspace.all` to the 14 | It still accepts the 21-scope union. |
| On refresh and claim, cap reported scopes to the 14 instead of failing | Matches the app's scope handling contract; saved grants keep working. |
| Keep accepting the old 21-scope refresh binding until older app versions are gone | Older apps still sign 21 scopes on refresh. |
| Stop offering Chat, People and Search for new sessions on the verified client | They are outside the 14. Keep refresh for saved grants. |
| Do not merge the branch that adds a Gmail archive profile | `gmail.modify` is restricted and not in the submission. |

Pending revocation (November 23): the app retries an unconfirmed Google
revoke in the background and handles both brokers. With the old broker, a
removed instance's revoke is refused (`403`) and retried until the 30-day hard
stop; once that broker change is deployed, those revokes succeed. Either
deploy order is safe.

Deploy order: **app first, then broker.** If the broker narrows first, refresh
from app versions that still sign 21 scopes fails.

## Where Google content is kept

From #22010's store inventory. The earlier audit understated it: it missed the
second audit table, approval cards, results passed to later runs, app views,
nested run answers and migrated log originals.

| Place | What is kept | Removed by "Delete data" | Task deleted | Company deleted |
| --- | --- | --- | --- | --- |
| Tool-call records (`tool_invocations`, `tool_call_events`) | About 4,000 characters of each request and result | Yes. Size and fingerprint kept. | Yes, cleared like "Delete data" | Yes, rows deleted |
| Connection audit history (`tool_access_audit_events`) | Argument preview | Yes. Decision, IDs, size and fingerprint kept. | Yes, for the task's runs | Yes, rows deleted |
| Approval requests and their approval cards in the task | Preview, arguments and the executed result | Yes, for settled requests. | Yes. Cards are deleted with the task; requests are cleared. | Yes, rows deleted |
| Results passed to a later run (run context and wake payload) | Approved action results | Yes, for settled runs and wakes. | Yes | Yes, rows deleted |
| App views | Tool input, result and shared context | Yes, rows deleted. | Yes, rows deleted | Yes, rows deleted |
| Run transcripts: the run log in every copy (object journal, archive, original local file and its S3 mirror), run events, output excerpts and answer text at any depth of the run result | Full content | Yes, the whole transcript of every settled run that called the connection or received an approved result. | Yes, for each of the task's runs that called a connection or received an approved result. The runs themselves stay. | Yes. Rows deleted, then every run log is removed from storage in the background. |
| Saved tool results over 500,000 bytes (`runner-api` files and their asset rows) | Full result | Yes, for the runs whose transcript is deleted. Files attached to a task stay. | Yes, for those runs | Yes, file and row |
| Comments, documents and attached files agents wrote into tasks | Whatever the agent copied | No, by design. The user edits or deletes them, or the task. | Yes. Attached files are also removed from storage, and retried until it succeeds. | Yes. Every company file is removed from storage in the background. |
| Transcripts of later runs that read an app view's shared context | Shared context | No. Nothing records which runs read it. | Only when the run belongs to the deleted task | Yes |
| Questions a provider asked a person; provider tool and skill definitions | Not tool results | No. | Not changed | Yes, rows deleted |
| Raw provider traces | Full traffic | No. Admin opt-in, encrypted, expire within 24 hours. | No | No, they expire |
| Feedback exports already sent | Run logs the user chose to share | No. Already outside Paperclip. | No | No |
| Optional model check for injection screening | If a company turns it on, the full tool result is sent to an OpenRouter model | Not stored by Paperclip. | Not stored | Not stored |
| Connection removal | Deletes tokens locally | Asks Paperclip Cloud to revoke at Google; it does so only when no other connection could share the grant. Customer-owned clients stay local. | Not changed | Connections are deleted locally; revocation at Google is not requested |

Task and company deletion are hard deletes. A task deletion queues an
`issue_connection_content_deletions` job that records the task's runs
(including runs still working), calls and call events, including calls made
without a run, before the task row goes, and runs the same steps as "Delete data". It
waits for runs and approvals that are still open, and finishes on its own. While
it waits it only rechecks open work, every one to five minutes for up to a day;
it then runs the content steps once more. A task whose only trace is an audit
entry also gets a job. It writes
`issue.connection_content_deleted` only when it deleted something, and
`issue.connection_content_deletion_incomplete` when it stopped waiting with
items still open. The ledger lives in `stored-object-deletion.ts` and the task
request in `issue-content-deletion.ts`. A company
deletion records every run log and file in `stored_object_deletions`, which has
no foreign key to the company, so the background removal outlives the company.
Both are covered by `tool-connection-content-deletion-canary.test.ts`.

What "Delete data" keeps: the record that each call happened (time, tool,
agent, outcome, size, fingerprint), and activity entries with counts only.

Limits:

- Runs still in progress are skipped and counted; delete again after they
  finish.
- A local log file on another server's disk stays until that server is
  replaced; its S3 mirror is deleted.
- On versioned buckets, earlier object versions stay until the bucket's
  lifecycle rule removes them.

The deletion is a durable request. It resumes after a restart and retries a
failed step until every step succeeds.

## Google review history

- September 30: we sent a revised submission.
- October 7: Google replied. Reviewers could not sign in because of the
  100-user cap, and the video did not show `gmail.readonly` working end to end.
  They asked for a separate test project set to In Production, working reviewer
  login, and a new video showing a full email in Paperclip and then the same
  email in Gmail.
- No newer message from Google as of November 15.
- Branding was verified at the last Console check; data access was still under
  review. Not rechecked since.
- The older videos and replies describe separate per-service connectors and
  removed services. Do not reuse them.

Note: on #21996 the ponytail reviewer flagged the October 7 summary above as
review correspondence in a public repository. We kept the summary.

## Privacy policy

- Lives in the `paperclip-website` repository at `web/app/privacy/page.tsx`,
  published at <https://paperclip.ing/privacy>. Last updated July 23, 2026.
- It already has what Google looks for first: a Google user data section
  (4.1) with the Limited Use statement and links to Google's policy.
- The edits are in paperclipai/paperclip-website PR 197, merged November 17.
  The published page now says that Google content is sent to the AI model
  provider configured for an agent, that agents create Gmail drafts and do not
  send, that content read by agents stays in tasks and runs until deleted, and
  how to delete data (full deletion within 30 days of a request).
- Still to check:
  - The no-training promise now covers only providers Paperclip selects and
    configures. Legal review needed.
  - Whether it covers the OpenRouter model used by the optional
    injection-screening check.
  - It names `my.paperclip.app` as the Google connection service on Paperclip
    Cloud; check that this matches the current flow.

## Other things to remember

- Security assessment: Google assigns the tier, we choose and pay the lab,
  and it repeats every 12 months.
- The connector is behind the default-off `enableGoogleWorkspaceConnector`
  experimental setting until Google approves.
- The synthetic test email has the marker `PAPERCLIP-QA-BODY-20261028`.
- The October 31 live evidence predates many changes to the sign-in code and
  must be redone.
