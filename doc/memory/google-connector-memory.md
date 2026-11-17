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

Last updated: November 17, 2026 (late evening).

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

In progress: the Drive, Docs and Slides, and Sheets REST tools.

### REST tools status

| Service | Implemented | Switched on |
| --- | --- | --- |
| Gmail | 9 of 9 | No |
| Calendar | 9 of 9 | No |
| Drive | 0 of 8 | No |
| Docs | 0 of 2 | No |
| Sheets | 0 of 6 | No |
| Slides | 0 of 2 | No |

"Switched on" means the service is `paperclip_rest` in
`GOOGLE_WORKSPACE_TOOL_TRANSPORT`. Today every service is `google_mcp`.

## Still open

- **What we send to the reviewers.** Not decided: the new staging tester or
  something else. Whatever it is must use the separate Google app (below).
- **How the staging tester reaches the separate Google app.** The broker
  cannot point one workspace at a different Google client (see
  "Environments"). Recommendation: add a per-workspace client override to the
  broker so reviewers see the real flow.
- **Reviewer login on staging.** The scoped reviewer password login is
  hard-coded to the production tester. The client override above does not fix
  this; how to enable the login on staging is still undecided.
- **AI-agent client and REST.** Whether an OAuth client marked for AI agents
  may call the REST APIs rather than MCP. To check before the staging tester is
  wired.
- **Three Gmail tools are inferred.** Google's MCP reference does not list
  `get_draft`, `list_threads` and `search_messages`; their schemas copy the
  sibling tools (#22014).
- **Privacy policy.** paperclipai/paperclip-website PR 197 is a draft waiting
  on Dotta's sign-off. It does not yet mention the OpenRouter model used by
  the optional injection-screening check; it must (see "Privacy policy").
- **The "no review correspondence" rule.** Narrow it or keep it (see "Google
  review history").
- Which security lab to use, and the budget.

## Environments

| Name | Address | Notes |
| --- | --- | --- |
| Earlier tester | `googletester.paperclip.app` (company prefix `GOO`) | On **production**. Used for earlier tests. Hard to deploy to; do not build on it further. |
| New tester | `googletester.staging.paperclip.app` | **To be created** on staging. Engineering qualification happens here. |
| Test 02 | In the private handoff | Staging stack used for the October proof. Holds Dotta's own Gmail grant, so not for reviewers. |
| Reviewer destination | Undecided | See "Still open". |

Creating the staging tester (as reported by the Nov 17 read-only audit; not yet
done):

1. On the staging account site, create an organization with the slug
   `googletester`. That gives `googletester.staging.paperclip.app`.
2. Pin its app version with the Cloud repository's deploy-stack command.
3. Turn on `enableGoogleWorkspaceConnector`.

Two obstacles (reported):

- The broker cannot point one workspace at the separate Google app. Every
  workspace in an environment uses that environment's one Google client.
- The scoped reviewer password login is hard-coded to the production tester.

Reviewer login: Google's reviewers could not use our normal sign-in, so we
gave them **a custom password** for the Paperclip login. Any reviewer
environment needs that again. The password itself goes only through the review
channel.

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

As reported by a read-only audit on November 17. Not re-verified here.

- The profile registry is at `src/connections/providers.ts`.
- One Google client per environment, shared by all profile groups. Staging's
  client differs from production's.
- `workspace.all` is enabled on staging only.
- There is no `gmail.archive` profile.
- A revoke endpoint exists, but every Google profile has revocation turned off.
- There is no per-workspace client override.

Changes needed in the broker:

| Change | Why |
| --- | --- |
| Limit `workspace.all` to the 14 | It still accepts the 21-scope union. |
| On refresh and claim, cap reported scopes to the 14 instead of failing | Matches the app's scope handling contract; saved grants keep working. |
| Keep accepting the old 21-scope refresh binding until older app versions are gone | Older apps still sign 21 scopes on refresh. |
| Stop offering Chat, People and Search for new sessions on the verified client | They are outside the 14. Keep refresh for saved grants. |
| Do not merge the branch that adds a Gmail archive profile | `gmail.modify` is restricted and not in the submission. |

Deploy order: **app first, then broker.** If the broker narrows first, refresh
from app versions that still sign 21 scopes fails.

## Where Google content is kept

From #22010's store inventory. The earlier audit understated it: it missed the
second audit table, approval cards, results passed to later runs, app views,
nested run answers and migrated log originals.

| Place | What is kept | Removed by "Delete data" |
| --- | --- | --- |
| Tool-call records (`tool_invocations`, `tool_call_events`) | About 4,000 characters of each request and result | Yes. Size and fingerprint kept. |
| Connection audit history (`tool_access_audit_events`) | Argument preview | Yes. Decision, IDs, size and fingerprint kept. |
| Approval requests and their approval cards in the task | Preview, arguments and the executed result | Yes, for settled requests. |
| Results passed to a later run (run context and wake payload) | Approved action results | Yes, for settled runs and wakes. |
| App views | Tool input, result and shared context | Yes, rows deleted. |
| Run transcripts: the run log in every copy (object journal, archive, original local file and its S3 mirror), run events, output excerpts and answer text at any depth of the run result | Full content | Yes, the whole transcript of every settled run that called the connection or received an approved result. |
| Comments, documents, files and chat messages agents wrote into tasks | Whatever the agent copied | No, by design. The user edits or deletes them, or the task. |
| Transcripts of later runs that read an app view's shared context | Shared context | No. Nothing records which runs read it. |
| Questions a provider asked a person; provider tool and skill definitions | Not tool results | No. |
| Raw provider traces | Full traffic | No. Admin opt-in, encrypted, expire within 24 hours. |
| Feedback exports already sent | Run logs the user chose to share | No. Already outside Paperclip. |
| Optional model check for injection screening | If a company turns it on, the full tool result is sent to an OpenRouter model | Not stored by Paperclip. |
| Connection removal | Deletes tokens locally | Does not revoke at Google. |

What "Delete data" keeps: the record that each call happened (time, tool,
agent, outcome, size, fingerprint), and activity entries with counts only.

Limits:

- Runs still in progress are skipped and counted; delete again after they
  finish.
- Deleting a task or a company does not yet run the same cleanup.
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
- The draft edits are in paperclipai/paperclip-website PR 197 (draft, awaiting
  Dotta's sign-off on the wording). It must also:
  - cover the OpenRouter model used by the optional injection-screening check;
  - match the picker's statement that results stay in task and run history
    until deleted.
- Gaps found November 17, to be fixed by that PR:
  - It does not say that Google content is sent to AI model providers to carry
    out tasks. It only names "cloud hosting and infrastructure providers".
  - It says connected-account data is kept only while the connection is active.
    In the product, email and file content that an agent read stays in task and
    run history after disconnect.
  - It says "read or send access to Gmail". We create drafts and do not send.
  - It names `connect.paperclip.ing` as the sign-in path; check that this
    matches the current flow.
  - It gives no steps or timeline for deleting data.

## Other things to remember

- Security assessment: Google assigns the tier, we choose and pay the lab,
  and it repeats every 12 months.
- The connector is behind the default-off `enableGoogleWorkspaceConnector`
  experimental setting until Google approves.
- The synthetic test email has the marker `PAPERCLIP-QA-BODY-20261028`.
- The October 31 live evidence predates many changes to the sign-in code and
  must be redone.
