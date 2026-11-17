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

Last updated: November 17, 2026.

## Decisions

| Date | Decision | Detail |
| --- | --- | --- |
| Nov 17 | **Owner for everything is Dotta** | Submission, security, privacy and release. |
| Nov 17 | **Launch on our own tools over Google's REST APIs** | Google's hosted Workspace MCP servers are still Developer Preview and cannot be offered to the public. We build our own tool set for agents that have this connector. |
| Nov 17 | **The REST tool set must be swappable for Google's MCP later** | Same tool names, inputs and results as Google's MCP tools, so switching back is a change of endpoint, not a rewrite. |
| Nov 17 | **The REST tool set lives in its own folder** | Nothing Google-REST-specific leaks into shared code; removing it later means deleting the folder and flipping one registration. Follow the boundary-discipline principle and `rules/module-boundaries.mdc`. |
| Nov 17 | **Engineering test instance moves to staging** | Create `googletester.staging.paperclip.app`; staging is far easier to deploy to. |
| Nov 17 | **Scopes must line up everywhere** | What the picker asks for, what the code accepts, what the Cloud broker allows, and what the Google Console declares are the same 14 scopes. |
| Nov 17 | **Assessment prep starts before Google asks** | Run the scans and fix findings now; the formal assessment starts on Google's notice. |

## Still open

- **What we send to the reviewers.** Not decided: the new staging tester or
  something else. Whatever it is must use the separate Google app (below).
- **Privacy policy edits** (see "Privacy policy" below).
- Which security lab to use, and the budget.
- Whether Google accepts the AI-agent client setting on a client that calls
  the REST APIs rather than MCP. To check before the staging tester is wired.

## Environments

| Name | Address | Notes |
| --- | --- | --- |
| Earlier tester | `googletester.paperclip.app` (company prefix `GOO`) | On **production**. Used for earlier tests. Hard to deploy to; do not build on it further. |
| New tester | `googletester.staging.paperclip.app` | **To be created** on staging. Engineering qualification happens here. |
| Test 02 | In the private handoff | Staging stack used for the October proof. Holds Dotta's own Gmail grant, so not for reviewers. |
| Reviewer destination | Undecided | See "Still open". |

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

One connection, three groups, **14 scopes** across all modes (9 for the
default all-read-and-write selection, 8 for all read-only). Prefix:
`https://www.googleapis.com/auth/`.

| Group | Read only | Read & write |
| --- | --- | --- |
| Gmail | `gmail.readonly` | `gmail.readonly`, `gmail.compose` |
| Drive, Docs, Sheets, Slides | `drive.readonly`, `documents.readonly`, `spreadsheets.readonly`, `presentations.readonly` | `drive.readonly`, `drive.file`, `documents`, `spreadsheets`, `presentations` |
| Calendar | `calendar.calendarlist.readonly`, `calendar.events.readonly`, `calendar.events.freebusy` | `calendar.calendarlist.readonly`, `calendar.events` |

- **Restricted (trigger the security assessment):** `gmail.readonly`,
  `gmail.compose`, `drive.readonly`.
- **Gmail write means drafts only.** `gmail.compose` would let an app send;
  our tool list has no send action. Never say the scope itself prevents sending.
- **Out of scope:** Chat, Contacts, Directory, cross-service Search. Not in the
  picker, the request, the tools, the docs or the submission.

Known mismatches to clean up:

- The `workspace.all` profile in code is still the 21-scope legacy union, and
  the server accepts any subset of it.
- The standalone Gmail card offers a Paperclip-managed "Read & archive" option
  that requests `gmail.modify` (restricted, not in the submission).
- What the Cloud broker allows and what the Google Console declares have not
  been compared with the 14 yet.

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

## Privacy policy

- Lives in the `paperclip-website` repository at `web/app/privacy/page.tsx`,
  published at <https://paperclip.ing/privacy>. Last updated July 23, 2026.
- It already has what Google looks for first: a Google user data section
  (4.1) with the Limited Use statement and links to Google's policy.
- Gaps found November 17, not yet fixed:
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
