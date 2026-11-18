# Google Workspace connector: production and Google approval checklist

Started November 17, 2026. This is the north star for getting the built-in
Google Workspace connector approved by Google and released to all users. Tick
items only when the evidence exists; add the date and a link next to the tick.

Background: [approval handoff](https://github.com/paperclipai/paperclip/blob/codex/google-workspace-draft-resume/doc/plans/2026-11-15-google-workspace-approval-handoff.md),
[connector doc](../connections/GOOGLE-WORKSPACE.md),
[code-fix plan](2026-11-17-google-workspace-code-fixes.md).
Account identifiers, credentials and review correspondence stay in the private
operator handoff, never here.

## Done means

- [ ] Google has explicitly approved data access for the exact scopes we request.
- [ ] The security assessment letter is accepted by Google.
- [ ] The connector is on for all users in production without the experimental
      setting, on a transport Google allows for public use.
- [ ] A new user can connect, run a task that reads and writes Google data, and
      disconnect, on production.

## The scope contract

One connection, 14 scopes; the table is in the working memory's
[Scopes](../memory/google-connector-memory.md#scopes) section. The target is
that nothing outside it is requested, declared in the Console, or shown in the
demo.

## 0. Decisions (Dotta)

Decisions and the details behind them are kept in the
[working memory](../memory/google-connector-memory.md).

- [x] **Launch transport** (Nov 17): our own tools over Google's REST APIs,
      built so we can switch to Google's MCP servers later.
- [x] **Owner** (Nov 17): Dotta owns submission, security, privacy and release.
- [x] **Engineering test instance** (Nov 17): create
      `googletester.staging.paperclip.app`.
- [ ] What we send to the reviewers (the staging tester or something else),
      including the custom reviewer password.
- [ ] Privacy policy edits approved.
- [ ] Security lab and budget.
- [ ] Email the Developer Preview team asking for permission to offer the MCP
      integration publicly (optional now, still cheap).

## 1. Baseline (needs the Google project owner's sign-in)

- [ ] Verification Center: is the case pending, waiting on us, or closed?
- [ ] Record the scopes declared in the Console and compare with the 14.
- [ ] Every OAuth client that calls Workspace MCP is marked as an AI-agent
      client; note any that missed the November cutoff and need replacing.
- [ ] Separate QA project is External and In Production, with user count noted.
- [ ] Reviewer callback URL is registered on the QA client.
- [ ] Branding preflight: homepage, privacy policy on the app domain and on the
      consent screen, verified domain, staffed support and developer contacts.
- [ ] Record the revision served by the reviewer environment.
- [ ] Check whether the daily OAuth monitor is still scheduled.

## 2. Product and code (see the code-fix plan)

- [x] Data-use disclosure shown in the picker immediately before Google consent
      (Nov 17, [#21998](https://github.com/paperclipai/paperclip/pull/21998)).
- [ ] Limited Use statement published and linked from the picker.
- [x] Help page: how to disconnect and how to delete stored Google data
      (Nov 17, [#22010](https://github.com/paperclipai/paperclip/pull/22010):
      `docs/guides/board-operator/deleting-connection-data.md`).
- [x] Paperclip-managed Google sign-in can only request the 14 scopes for the
      unified connection (Nov 17,
      [#22001](https://github.com/paperclipai/paperclip/pull/22001)). The Cloud
      broker still accepts more; see the working memory.
- [x] `gmail.modify` is not reachable through the Paperclip-managed client
      (Nov 17, [#22001](https://github.com/paperclipai/paperclip/pull/22001)).
- [x] Prompt-injection screening confirmed on every Google tool result
      (Nov 17, [#21999](https://github.com/paperclipai/paperclip/pull/21999)).
- [ ] Disconnecting the last Google connection revokes the grant at Google.
- [x] Retention and deletion of Google content in tasks, runs and files audited
      (Nov 17, [#22010](https://github.com/paperclipai/paperclip/pull/22010)
      store inventory; summary in the working memory's "Where Google content
      is kept"). Users can now delete it per connection. Content agents wrote
      into tasks stays, and task or company deletion does not yet run the same
      cleanup.
- [x] REST-backed tool set for all 36 actions exists but is not switched on
      (Nov 17): Gmail 9
      ([#22000](https://github.com/paperclipai/paperclip/pull/22000),
      [#22014](https://github.com/paperclipai/paperclip/pull/22014)),
      Calendar 9 ([#22017](https://github.com/paperclipai/paperclip/pull/22017)),
      Sheets 6 ([#22027](https://github.com/paperclipai/paperclip/pull/22027)),
      Docs 2 and Slides 2
      ([#22029](https://github.com/paperclipai/paperclip/pull/22029)), Drive 8
      ([#22028](https://github.com/paperclipai/paperclip/pull/22028)). The
      per-service switch exists
      ([#22016](https://github.com/paperclipai/paperclip/pull/22016)).
- [ ] Each service switched to REST after a live test on the staging tester.
- [ ] Scopes identical in the picker, the server, the Cloud broker and the
      Google Console.
- [x] `googletester.staging.paperclip.app` created (Nov 18).
- [ ] Staging tester wired to the new Google app.

## 3. Policy and privacy

The policy is in the `paperclip-website` repository
(`web/app/privacy/page.tsx`, <https://paperclip.ing/privacy>).

- [x] Policy has a Google user data section with the Limited Use statement.
- [x] Policy states that Google data is not used to train general models.
- [x] Policy says Google content is sent to AI model providers to carry out
      tasks, and names them or the category (Nov 17, [paperclip-website PR 197](https://github.com/paperclipai/paperclip-website/pull/197)).
- [x] Policy's retention wording matches the product (content read by agents
      stays in task and run history after disconnect), or the product changes
      (Nov 17, [paperclip-website PR 197](https://github.com/paperclipai/paperclip-website/pull/197)).
- [x] Policy says Gmail drafts, not "send" (Nov 17, [paperclip-website PR 197](https://github.com/paperclipai/paperclip-website/pull/197)).
- [x] Policy gives the steps and timeline for deleting data (Nov 17, [paperclip-website PR 197](https://github.com/paperclipai/paperclip-website/pull/197)).
- [ ] Legal review of the narrowed no-training wording in [paperclip-website PR 197](https://github.com/paperclipai/paperclip-website/pull/197) (it now
      covers only providers Paperclip selects and configures). Not required
      for Google approval.
- [ ] Policy's description of the sign-in path matches the current flow.
- [ ] Model-provider terms and settings checked against that statement.
- [ ] Data-flow inventory written: Google, broker, server, runner, model
      provider, storage, support and diagnostics.
- [ ] Scope justification written for each of the 14 scopes, including why a
      narrower scope does not work.

## 4. Security assessment (CASA)

- [ ] Run static and dynamic scans against the CASA requirements ourselves.
- [ ] Fix or document every finding.
- [ ] Draft the self-assessment questionnaire.
- [ ] Choose a Google-authorized lab and get a quote.
- [ ] Google's assessment notice received (tier recorded).
- [ ] Lab validation passed.
- [ ] Letter of Assessment sent to Google.
- [ ] Renewal date and owner recorded (every 12 months).

## 5. Reviewer environment

- [ ] Instance deployed on a current build and wired to the separate QA project.
- [ ] Confirmed from a real authorization request that the QA client is the one
      used.
- [ ] Dedicated test Google account with synthetic mail, files and events.
- [ ] Reviewer login works without phone, payment or other blockers.
- [ ] Fresh reviewer can connect and run their own model-backed task.
- [ ] No access from the reviewer account to anyone else's connections, tasks
      or results.
- [ ] Access details ready to send through the review channel only.

## 6. Live acceptance on the reviewer environment

- [ ] First use: defaults, deliberate selection, Cancel, retry, reload, no
      duplicate connection.
- [ ] Consent: Gmail only, Drive group only, Calendar only, read only versus
      read & write, and partial consent on Google's screen.
- [ ] Reads: full email body, Drive search and file content, Doc, Sheet values,
      Slides, calendar list, events, free/busy.
- [ ] Writes: Gmail draft (unsent), file create and copy, Doc, Sheet and Slides
      edits, event create, update, delete and respond; each shown in Google.
- [ ] Lifecycle: reconnect, token refresh during a real run, revoked access,
      reduced access, clear recovery message.
- [ ] Denials: a real call to an unselected service, a write on a read-only
      grant, and a cross-company attempt, each refused with no change in Google.
- [ ] Each of the 14 scopes mapped to a passing test.

## 7. Demo video

- [ ] Real browser with the address bar and OAuth client ID readable.
- [ ] Consent screen in English with all permissions expanded.
- [ ] Email shown in full in Paperclip, then the same email in Gmail.
- [ ] Every scope shown in use, with a chapter per scope.
- [ ] Task automation and the direction of data flow explained.
- [ ] No private data visible; plays for someone outside the team.
- [ ] Uploaded to YouTube as Unlisted.

## 8. Submission

- [ ] Console declaration updated to the 14 scopes.
- [ ] Point-by-point reply to Google's October 7 message drafted.
      Note: the ponytail reviewer flagged the summary of Google's reply in the
      working memory's review history as review correspondence; we kept the
      summary.
- [ ] Reviewer login and steps tested by someone who has not seen the app.
- [ ] Dotta approves sending.
- [ ] Console update submitted once and reply sent in the existing case.
- [ ] Reviewer environment, test data and model access kept running during review.
- [ ] Each Google finding tracked with owner, date and resolution.

## 9. Release (after explicit approval)

- [ ] Approval captured with the project, clients and scopes it covers.
- [ ] Production broker enables the unified profile with matching scopes.
- [ ] Canary on one production workspace: connect, read, write, disconnect.
- [ ] Experimental setting removed; connector on by default.
- [ ] Release notes and user help published.

## 10. Ongoing

- [ ] Alerts for sign-in, refresh and Google denial failures.
- [ ] Annual security reassessment scheduled.
- [ ] Rule recorded: any new scope, client or data use goes back to Google first.
