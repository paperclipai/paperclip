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

Last updated: November 24, 2026.

## Decisions

| Date | Decision | Detail |
| --- | --- | --- |
| Nov 17 | **Owner for everything is Dotta** | Submission, security, privacy and release. |
| Nov 17 | **Launch on our own tools over Google's REST APIs** | Replaced on Nov 24 (see below). Google's hosted Workspace MCP servers were still Developer Preview and could not be offered to the public. We built our own tool set for agents that have this connector. |
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
| Nov 23 | **All six launch services switched to REST now** | Replaced on Nov 24 (see below). Gmail, Drive, Docs, Sheets, Slides and Calendar were `paperclip_rest`. This replaces the Nov 17 "one service at a time after a live test" rule: live testing happens on the staging tester right after the switch deploys, and problems are fixed forward. Chat, People and Search stay on `google_mcp`. |
| Nov 23 | **Write actions default to "Allowed"** | No approval step by default, including actions labelled destructive. Operators can still set Ask first per action. |
| Nov 23 | **Images by public web address are allowed in Docs and Slides** | `insertInlineImage`, `replaceImage`, `createImage` and `replaceAllShapesWithImage` may use any public link. Links to Drive or Docs files stay refused (Nov 17 rule). Accepted risk: Google, not Paperclip, fetches the address, and Paperclip's own requests still go only to the allowed Google hosts. What remains is that an agent could put data in the address it chooses. Owner decision; do not restrict it. |
| Nov 23 | **Unconfirmed Google revocation is retried by the app, not Cloud** | When access must end and Google cannot be reached or confirm, the app keeps the token in `google_pending_revocations` and retries (1 minute up to 6 hours backoff, 30-day hard stop). Cloud still never stores provider tokens. Company deletion and a Cloud-removed instance queue the same way. The broker lets a removed instance sign a Google revoke (Cloud broker change, November 23). See [connector doc](../connections/GOOGLE-WORKSPACE.md), "Pending revocation". |
| Nov 23 | **Paperclip's Google sign-in is for Paperclip Cloud only** | Self-hosted instances bring their own Google OAuth client. Google's restricted-scope verification and security assessment cover Paperclip's infrastructure, so the broker does not give restricted-scope Google tokens to servers Paperclip does not run. The app hides the method on self-hosted instances and refuses to start it; the broker refuses it too (`PROVIDER_CLOUD_ONLY`). Google connections a self-hosted instance already has keep refreshing until a sunset date the owner will set on the broker; after it, the app asks the user to reconnect with their own Google client. |
| Nov 23 | **Google's reviewers get the staging tester** | `googletester.staging.paperclip.app`, on the separate Google app, pinned to a tested build. Not the production tester. |
| Nov 23 | **Security lab: TAC Security (recommended, not yet engaged)** | Google's discounted Tier 2 partner. Plan about $2,000 for year one including a retest. Confirm with a quote; Google assigns the tier. |
| Nov 23 | **A tool refuses an argument it does not know** | All 36 tools fail before any request to Google and name the accepted arguments. Found live: `list_threads` ignored a filter and returned unfiltered mail. |
| Nov 23 | **A cancelled or abandoned first sign-in leaves no connection** | Cancel removes the draft; a closed tab leaves a hidden draft that the next attempt reuses. Applies to every sign-in connector. |
| Nov 24 | **Back to Google's MCP servers for all six services, before the demo video and the submission** | Gmail, Drive, Docs, Sheets, Slides and Calendar are `google_mcp` again. Reason: Google's Workspace AI Tools Addendum (published Nov 24, see "Google AI Tools Addendum") says a tool that is, or is driven by, an AI agent must use a Google MCP and not the REST APIs, and forbids hiding that classification. Google made its Workspace MCP servers generally available the same day. |
| Nov 24 | **The REST tool set stays as the fallback** | `server/src/google-workspace-rest-tools/` and the `GOOGLE_WORKSPACE_TOOL_TRANSPORT` switch stay in the code. Do not delete them. The REST argument checks that need no request to Google also run before each call to Google's MCP servers. |
| Nov 24 | **Every OAuth client that calls Google's MCP servers is an agent client** | Google's MCP servers reject an OAuth client that is not marked "Use this client for an AI-powered agent" in the Google Console. The coordinator changes the Console setting; there is no code for it. |
| Nov 24 | **Comply with Google's AI Tools Addendum: delete on disconnect or revocation, keep Google Technical Information at most 30 days** | Owner: "please make sure we abide by google's terms." Every way a Google connection ends now starts the durable content deletion on its own (first PR). The 30-day limit and the no-training check follow in a second PR. See "Retention under the AI Tools Addendum". |
| Nov 24 | **The service picker shows no explanatory text, only the privacy policy link** | Owner decision. This removes the in-product data-use disclosure added on Nov 17 ([#21998](https://github.com/paperclipai/paperclip/pull/21998)). Risk noted by the coordinator: Google's user data policy may expect an in-product disclosure before consent; if a reviewer asks, restore a short statement above the link. |

## What has shipped

| PR | What it does | Merged commit |
| --- | --- | --- |
| [#21996](https://github.com/paperclipai/paperclip/pull/21996) | Plan docs: this file, the production checklist and the code-fix plan. | `12cb18e17d` |
| [#21998](https://github.com/paperclipai/paperclip/pull/21998) | Data-use disclosure in the service picker, shown just before Google consent. Every Google Workspace sign-in start goes through the picker, including four sign-in paths on the app page (Reconnect, Connect as me, Connect organization identity, dedicated-agent connect). The Gmail read & write line says Google's screen also mentions sending and that Paperclip does not send. Removed on Nov 24 by owner decision (see "Decisions"); the picker keeps the privacy policy link. | `b124ad0674` |
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
| [#22815](https://github.com/paperclipai/paperclip/pull/22815) | All six services back on Google's MCP servers (Nov 24). The REST argument checks that need no request to Google run before each MCP call. A refresh that replaces saved REST definitions holds nothing for review. REST tools stay as the fallback. | Squash merge of this PR |

The REST tool set covers all 36 actions. All six services ran on it from Nov 23 to Nov 24 and are back on Google's MCP servers since Nov 24; the REST tool set is the fallback.

### REST tools status

| Service | Implemented | Switched on |
| --- | --- | --- |
| Gmail | 9 of 9 | No. On REST Nov 23 to Nov 24 |
| Calendar | 9 of 9 | No. On REST Nov 23 to Nov 24 |
| Drive | 8 of 8 | No. On REST Nov 23 to Nov 24 |
| Docs | 2 of 2 | No. On REST Nov 23 to Nov 24 |
| Sheets | 6 of 6 | No. On REST Nov 23 to Nov 24 |
| Slides | 2 of 2 | No. On REST Nov 23 to Nov 24 |

"Switched on" means the service is `paperclip_rest` in
`GOOGLE_WORKSPACE_TOOL_TRANSPORT`. Since Nov 24 every service is
`google_mcp`.

### On Google's MCP servers (since Nov 24)

What Paperclip still does before it sends a call to Google's MCP server:

- Offers only the actions on the allowlist (`toolScopes` in
  `packages/shared/src/google-workspace-connectors.ts`) that the grant
  covers. A tool that Google's server lists and the allowlist does not (Gmail
  send, Drive delete or sharing, Gmail archive, Chat, People, Search) never
  reaches an agent.
- Refuses an argument that the action's saved schema does not list (top
  level always; inside an object only when the schema closes that object).
- Requires one file ID (no link, no list) in `fileId`, `parentId`,
  `documentId`, `spreadsheetId` and `presentationId`.
- Docs and Slides edits: the closed list of request kinds, including the
  refusal of kinds that read another file and of images from Drive or Docs
  links.
- `delete_event`: reads the event first with Google's `get_event` and refuses
  a whole recurring series. If that read does not return the event, nothing
  is deleted.
- Off, Ask first, approval, readable action names, audit, invocation records
  and prompt-injection screening run as on REST.
- A confirmation question from Google (MCP elicitation) goes on the task's
  question card for a person. Skipping it sends "decline"; until it is
  answered, the call stops again and nothing is changed.
- Switch-back fix (Nov 25, `fix/google-mcp-adopt-saved-rest-definitions`): #22815 recognised only the current REST schemas, so rows saved by #22634 (before the #22706 strict schemas) were held for review on the staging tester (34 of 36). A refresh now adopts Google's definition for any shipped REST schema hash (`shipped-schema-hashes.ts`). Actions already held stay held for a person to review: the hold replaced the saved definition, and no record proves the row's definition before the hold (an auto-release from call history was dropped after review, because a refresh can save rows and stop before its audit).

What only the REST tools did, and does not happen on MCP:

- `requiredRevisionId` being mandatory for Docs and Slides edits.
- A connection whose catalog was saved on REST keeps the REST definitions
  for agents until its next catalog refresh. The refresh saves Google's
  definitions and does not hold those actions for review. Gmail
  `get_draft`, `list_threads` and `search_messages` are not in Google's
  published reference; if Google's server does not list them, the refresh
  removes them.

### Known differences from Google's tools

From the folder README (`server/src/google-workspace-rest-tools/README.md`).
They apply only while a service is on the REST fallback.

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
- **Live test on Google's MCP servers.** The switch back (Nov 24) is tested
  with fakes only. On the staging tester: mark the client as an agent client,
  enable the six MCP APIs, then run all 36 actions, one Google confirmation
  answered and one declined, disconnect and "Delete data".
- **Retention after disconnect (owner decision).** See "Google AI Tools
  Addendum".
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

1. Mark the OAuth clients as agent clients in the Google Console and test
   the MCP build live on the staging tester (see "Still open").
2. Owner signs in as the reviewer on the staging tester; then test connect,
   an agent task, disconnect and "Delete data" as the reviewer.
3. Deploy to production on the owner's go: app first, then broker. The
   production GitHub Environment already has the reviewer login switch set
   to on (November 23), so no action is needed there. Without that switch,
   a production deploy would turn the production tester's reviewer login
   off.
4. Get a quote from the security lab.
5. Record the demo video and prepare the reply to Google.
6. Update the Console declaration to the 14 when submitting.

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
  client. For the MCP build it also needs the six Workspace MCP APIs enabled
  and its client marked as an agent client (not done as of Nov 24). The consent screen names the app by its domain and shows one
  unticked box per permission. The staging environment lists the tester's
  stack for the alternate client, for the Workspace group only.
- Never set the alternate stack list before its client secret exists: the
  Google bootstrap step then fails and blocks every staging deploy.
- **Reviewer login is switched on, not yet handed over.** The deploy owns
  the switch (`CLOUD_HARNESS_REVIEWER_LOGIN_ENABLED` in the GitHub
  Environment). The reviewer account is a `member` of the workspace. A
  wrong review code is refused. Sign-in with the real review code is not
  tested (see "Still open").

Passed live on the tester, on the REST build against real Google (November 23;
the MCP build is not tested live yet):

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

Checked on the MCP build before the REST switch only (test again on the
current MCP build):

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
- On Google's MCP servers (since Nov 24), each project needs the Gmail,
  Drive, Docs, Sheets, Slides and Calendar MCP APIs enabled, and each OAuth
  client that calls them marked "Use this client for an AI-powered agent".
  Keep the REST APIs enabled too, for the fallback.

## Google AI Tools Addendum

Published November 24, 2026 with the general availability of Google's
Workspace MCP servers: <https://workspace.google.com/terms/ai-tools>.

- A tool that is, or is driven by, an AI agent must use a Google MCP, not the
  REST APIs. Hiding that classification is forbidden. This is why all six
  services are back on Google's MCP servers.
- Google's MCP servers reject an OAuth client that is not marked "Use this
  client for an AI-powered agent".
- **February 1, 2027:** technical enforcement starts.
- **April 1, 2027:** paid tier for the Gmail, Drive and Calendar MCP servers,
  billed from the first request.
- **Free tier:** 5,000 requests per day per project per product.
- Retention (owner decided Nov 24 to comply): user data only for active,
  user-authorized tasks; nothing kept after a disconnect or revocation, user
  data or Google Technical Information; Google Technical Information kept at
  most 30 days; no training, fine-tuning, evaluation datasets or distillation;
  no scraping or probing beyond the user's tasks. Google Technical Information
  means information obtained or derived from Google's access points, for
  example embeddings, memory indexes, user profiles, organizational graphs and
  failure patterns, and never user data. Status and inventory: "Retention
  under the AI Tools Addendum".

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

Since November 24, a Google connection's content is also deleted on its own
when access ends; see "Retention under the AI Tools Addendum" for the
triggers and the newer inventory.

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
  finish. A deletion started because access ended waits for them instead.
- A local log file on another server's disk stays until that server is
  replaced; its S3 mirror is deleted.
- On versioned buckets, earlier object versions stay until the bucket's
  lifecycle rule removes them.

The deletion is a durable request. It resumes after a restart and retries a
failed step until every step succeeds.

## Retention under the AI Tools Addendum

Owner decision, November 24: comply. Two PRs. The first (delete when access
ends) is described here. The second adds the 30-day limit for Google
Technical Information and closes the training and export findings below.

### When access ends, the content is deleted

The connection's content deletion ("Delete data") now starts on its own,
saved in the same database transaction that ends the access, for a Google
connection (its app template, read with the canonical source-template
precedence, is a Google app, or its broker profile is a Google profile). The job row records why (`reason`):

| Event | `reason` | Where |
| --- | --- | --- |
| Connection removed | `connection_removed` | `connections/removal.ts` |
| A grant revoked (personal, agent or organization) | `access_revoked` | `connections/grants.ts` |
| Refresh shows Google ended the access: broker `409 PROVIDER_REAUTHORIZATION_REQUIRED`, or `invalid_grant` from Google's token endpoint | `provider_access_ended` | `oauth/grant-refresh.ts`, `oauth/connection-refresh.ts` |
| The grant's owner leaves the company or loses membership | `member_removed` | `services/access.ts` |
| Paperclip Cloud removed the instance | `instance_removed` | `google-pending-revocation.ts` |
| Company deleted | rows deleted with the company | `company-deletion.ts` (unchanged) |

Not a trigger: a network failure, a broker outage, Google `5xx`, a scope
mismatch, the Cloud-only sign-in refusal, and a refresh answer that arrives
after a new sign-in. Non-Google apps are unchanged. Revoking an organization
grant starts the deletion even when the connection keeps its own credential:
the person chose to disconnect that identity.

- Scope: everything the connection saved up to the moment access ended, for
  every person who used the connection. Calls do not record which grant made
  them, so one person's disconnect deletes the whole connection's saved
  content. Recording the grant on each call would let this narrow later.
- Window: starts at once and normally finishes within minutes. Work still
  running keeps its content until it settles; the job then deletes it. It
  rechecks running work every 1 to 5 minutes, and hourly after the first day,
  until none is left, then runs every step once more and finishes. A failed
  step is retried until it succeeds, across restarts (the existing durable
  job, plus `not_before`). A task deletion keeps its 24-hour wait limit.
- An access end while any deletion is pending moves that job's cutoff to the
  access end and restarts it (a later access end must also cover calls other
  grants made in between). "Delete data" while an automatic deletion is
  pending moves its cutoff to now and keeps it waiting for running work.
- Reconnect: only calls made after the access end are kept. Late records of
  a call made before the access end (a completion event, an app view, an audit
  entry written after the result came back) are deleted too. The job also
  clears the saved harness session pointers (`agent_task_sessions`,
  `agent_runtime_state.session_id`) and the session ids on every run of that
  harness session (`session_id_before`, `session_id_after`, the result's
  `sessionId`), so neither the next run nor "resume from this run" reopens a
  conversation that holds old Google results. The run's result gets a
  `contentDeletedAt` mark; run completion checks it after saving session
  pointers and clears them again. Before resuming, Paperclip also refuses a
  saved task session or runtime session whose last run carries the mark, and
  refuses "resume from this run" for a marked run. So a session restored by a
  crash between saving and clearing is never resumed.
- A refresh failure counts only if the refresh still holds the grant's
  refresh lease; a late answer after a new sign-in deletes nothing.
- New in the job for every app: tool error text (`tool_invocations` and
  `tool_call_events` `error_message`, the approval card's
  `toolAction.errorMessage`), and the session pointers above.
- Activity: `tool_connection.content_deletion_started` (reason) and the
  existing `tool_connection.content_deleted` (counts).
- UI: the Google remove dialog, the app's "Remove this app" row and the revoke
  identity dialog say the data is deleted; the remove dialog does not offer
  the "also delete data" option for Google. The "Delete data" dialog says when
  a deletion started because access ended.

### Inventory (November 24)

User data obtained from Google:

| Place | Delete data before | When access ends (first PR) | Second PR |
| --- | --- | --- | --- |
| Tool-call records: request and result previews | Yes | Yes | |
| Tool-call error text (invocations, call events, approval card) | No | Yes | |
| Connection audit history (argument preview) | Yes | Yes | |
| Approval requests and cards | Yes | Yes | |
| Results passed to a later run (run context, wake payload) | Yes | Yes | |
| App views | Yes | Yes | |
| Run transcripts: run log in every copy, run events, excerpts, answer text | Yes | Yes, also for runs that were still working | |
| Saved large results (`runner-api` files) | Yes | Yes | |
| Saved harness session pointers | No | Yes | |
| The harness's own transcript files on the agent's machine or sandbox (Codex `sessions`, Claude `projects`, ACP) | No | No; no longer resumed | Not yet. Open: delete the session files where Paperclip owns the folder (local adapters) and the sandbox copy |
| `paperclip_runner` harness backups and runner checkpoints (encrypted) | No | No; removed 7 days after the task closes | Not yet. Open: remove the backups of a cleaned run's task at once |
| Task document `continuation-summary` and its revisions (system copy of the run summary and run error) | No | No | Yes: revisions the cleaned run wrote are emptied, and the document body if that revision is the latest. Later revisions can keep paths or a next action carried over from it |
| Handoff copy of the last run summary in the next run's context | No | No | Yes: removed from later settled runs of the same task, and from a run still working when it finishes; never included in training or feedback exports |
| `native_run_results.result_json`, `heartbeat_runs.error` | No | No | Yes: every free-text value in the native result cleared (structural keys stay), and the run error cleared |
| Decision training examples (manual snapshots of runs and cards; JSONL export) | No | No | Yes: a new snapshot stores only id, status and times for runs that called Google, received an approved Google result, or share a harness session with such a run, and drops the Google action from the card; the JSONL export applies the same rule to examples saved earlier; a cleaned run is replaced the same way in stored snapshots |
| Feedback exports (local payload; bundle sent to Paperclip Labs when sharing is on) | No | No | Yes: a shared trace whose run, or any run of its harness session, called Google carries only run id, status and times; no events, log or harness files |
| Customer observability export (OTLP or Braintrust, tool content on by default) | Outside Paperclip | Outside Paperclip | Not changed. Owner question below |
| Raw provider traces | Expire in 24 hours | Expire in 24 hours | |
| Comments, documents, descriptions, work products, agent memory files and attachments that agents wrote | No, by design | No | Owner question below |
| Text search indexes | Follow their rows | Follow their rows | |
| Embeddings, vector stores | None exist | | |

Google Technical Information (derived, not user data):

| Place | Second PR |
| --- | --- |
| Tool catalog from Google's `tools/list` (title, description, schemas, annotations, app view, icons) | Stripped 30 days after Google last listed the tool, and at once when the connection is removed. Name, risk and status stay. An active connection's catalog is marked stale, so the next read lists the tools again |
| Connection health message and last error (Google failure text) | Cleared 30 days after the last check, and at once when the connection is removed |
| Tool-call error messages (invocations, call events, approval card) | Cleared 30 days after the call, and at once when access ends (first PR). Status and error code stay |
| Scope evidence on a revoked grant (`providerTenant.oauth`) | Removed at once. A live grant keeps it: it is the record of the user's current consent, needed to run the grant |
| Prompt-injection screening findings (labels, no content) | Kept: Paperclip's own classification of a result, not information from Google's access points |
| `google_pending_revocations` | Already: 30-day hard stop |
| Activity rows for tool calls (IDs and status only) | Kept: activity log invariant |

The sweep (`google-technical-information.ts`, worker
`google-technical-information-work.ts`) follows the sleep-aware rule: its next
deadline is the oldest item plus 30 days. While a Google connection that is
not removed exists, it is never later than the start of today (UTC) plus 30
days, a value that stays the same all day. Any item created later is due later
than that, so no deadline is missed without hooking every gateway path that
writes an error. With no live Google connection and nothing left to clear it
schedules nothing. Removing a connection, ending access and a catalog refresh wake it
through a transaction-aware notification. The idle deadline proof includes the
same deadline, so a sleeping instance wakes for it. Two partial indexes
(`tool_invocations` and `tool_call_events` on `connection_id, created_at`
where `error_message` is set, migration 0507, built concurrently) keep the
deadline query cheap.

Google tools create no attachments: Drive downloads come back inside the tool
result (covered above), so there is no byte-copy attachment to delete.

### No training or scraping (checked November 24)

- Product analytics (connector telemetry and browser PostHog) carry no tool
  arguments or results: connector events send only the app key, domain,
  transport, status, origin and duration; browser text is masked.
- Server OpenTelemetry runs only when configured and adds no content.
- Decision training examples and Feedback exports to Paperclip Labs could
  carry Google results. Both now leave them out (second PR).
- No embeddings, vector stores, evaluation datasets or model training use
  Paperclip data. Tool calls happen only in an agent's task; the catalog is
  listed when a connection is set up or its cache expires on use.

### Owner question: customer observability export

A company admin can send agent traces to their own OTLP endpoint or to
Braintrust. Tool content is on by default, so Google results go there too.
This is the customer's own processing, not Paperclip's, but Braintrust is an
evaluation platform. Options: keep it (customer's choice; say so in the
policy), turn tool content off by default for Google tools, or refuse
Google tool content in that export.

### Owner question: content agents wrote from Google data

Comments, documents, issue descriptions, work products, agent memory files
and attachments that an agent wrote while using Google tools stay after a
disconnect. Options:

1. **Keep, and say so** (today). Simple and no surprise loss of work. Risk:
   an agent that pasted an email verbatim leaves Google user data behind, which
   the addendum forbids after disconnect.
2. **Record and delete.** Record on each comment, document, work product and
   attachment that its run used Google tools; when access ends, delete or
   redact them with the rest. Strongest compliance. Deletes the user's own
   work product, needs provenance tracking in several write paths, and cannot
   catch text an agent carried into a later run without Google.
3. **Record and ask.** Record provenance as in 2; when access ends, show the
   owner the list and delete it after 30 days unless kept. Balanced, but needs
   new UI and leaves a 30-day window.

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
