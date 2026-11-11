# Slack chat connector production acceptance

Status: draft checklist, not yet run.

## Why this exists

The Slack chat connector is close to production, but its live evidence is out of
date:

- The [September live results](chat-adapters/2026-09-05-slack-live-qualification-result.md)
  were recorded on September revisions. Since then Slack moved into channel
  modules and gained sealed Cloud events, durable form custody and receipts, and
  faster acknowledgements. That evidence no longer covers the code we ship.
- The [automatic setup run of 2026-10-07](../connections/SLACK-AUTOMATIC-SETUP.md)
  was partial. Same-thread follow-up, reauthorization, and removal were never
  run live.
- The [Cloud qualification harness](../testing/slack-cloud-qualification.md) is
  local and never calls Slack. It is fixture coverage, not live evidence.
- Managed setup (Cloud one-click) has never run against real Slack.
  [slack-setup.md](../connections/slack-setup.md) says not to enable its tenant gate
  until it has.

This checklist replaces the old matrices with one fresh pass on current
`master`. It is done when every row in sections A–E has a recorded outcome on
one tested revision, and every failure is either fixed (with a regression test)
or written up as a known limitation that we accept.

## Evidence rules

- Record the tested `master` SHA, the instance URL, and the date for each section.
- Use a dedicated test Slack workspace and dedicated test apps. Never use a
  customer workspace.
- Record sanitized IDs and links (task, run, Slack permalink) and the outcome.
  Never record tokens, signing secrets, OAuth codes, or provider payloads.
- Keep live results separate from fixture results. A Storybook story or Vitest
  case does not satisfy a row here.
- A failed attempt stays failed. If a later retry passes, record both.
- After a fix lands, rerun only the rows whose code paths changed, on the new SHA.

## A. Self-hosted automatic setup

Instance: isolated HTTPS self-hosted Paperclip with `enableChatConnectors` on.
The tester enters the App Configuration Token directly.

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| A1 | Create the app from the wizard | One app exists in Slack with the agent's name, icon, and slash command; no duplicate app after any retry | |
| A2 | OAuth install and return | Consent returns to the wizard and the setup advances without a manual refresh | |
| A3 | Request URL verification | Slack's signed challenge succeeds, or the first signed event advances setup on its own | |
| A4 | Installer linking and welcome DM | The installer is linked and receives exactly one welcome DM | |
| A5 | First real message | A DM to the bot creates a task, the assigned agent's run succeeds, and the reply appears in the same Slack thread | |
| A6 | Same-thread follow-up | A second message in that thread reaches the same task and gets a reply in the thread | Never run live |
| A7 | Interrupted setup | Closing the browser mid-setup and reopening resumes at the right step, without creating a second app | |
| A8 | Reauthorize the same app | Reauthorization keeps the same app and connection, and messages still flow afterward | Never run live |
| A9 | Remove the connection | Removing it in Paperclip stops delivery. Any outstanding attempt ends cleanly, with no retry storm and no orphaned task | Never run live |
| A10 | Uninstall from Slack | `app_uninstalled` / `tokens_revoked` marks the connection disconnected. The UI offers a working reconnect | |

## B. Self-hosted manual and existing app

Run against the same instance as section A.

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| B1 | Manual: create an app from the generated manifest, paste the bot token and signing secret | Setup completes and A5 passes for this app | |
| B2 | Existing app: paste credentials for an app created outside Paperclip | Setup completes and A5 passes, or setup explains exactly which scope or event is missing | |
| B3 | Wrong signing secret | Setup reports the error in plain language, never a raw ID or provider error text | |

## C. Conversation behavior

All setup methods share one runtime, so run this once on the section A app and
spot-check C1, C2, C5, and C6 on the section D app. Cloud handles slash commands
apart from events, and they need a synchronous response. So for C5 on Cloud, also
send a slash command while the tenant sleeps, and require both the command response
and its task thread to arrive.

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| C1 | Channel root mention | Creates a task, and the reply lands in the thread | |
| C2 | Message during a run | Is queued in order and answered without being batched with another conversation | |
| C3 | Working status | The Agents & AI Apps status shows working while the run is active and clears when it finishes | |
| C4 | Stop from Slack | `agent_session_stopped` stops the run, and Slack shows that it stopped | |
| C5 | Slash command | Starts work from the command and creates its thread | |
| C6 | Agent question | The agent's question arrives as a Slack form, and the answer continues the same task | |
| C7 | Files in and out | An uploaded file reaches the agent. A file the agent produces appears in Slack | |
| C8 | Receipt reaction | The receipt reaction appears on intake and is removed or replaced on completion | |
| C9 | Unlinked guest | A message from an unlinked user is handled by the guest policy, with a clear message and no internal jargon | |
| C10 | Deploy mid-run | Restarting the server during a run finishes the run or resumes it. The Slack reply arrives exactly once, and Retry is never needed | |
| C11 | Agent read tools | Channel and thread read tools return results. Record the latency of a thread read and any `ratelimited` responses (see E2) | |

## D. Cloud managed setup on staging

Prerequisites (blockers until done):

- Slack has granted the `managed_apps:install` partner scope to Paperclip's
  manager app.
- The staging Cloud broker has the `slack.manager` profile enabled, with the
  manager app's client secret in the broker secret store.
- The staging tenant has `PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED=true` and the
  chat-connector gate on.

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| D1 | Manager grant | A user authorizes the manager app once. The grant is bound to that user, company, and workspace | |
| D2 | One-click agent install | **Continue** creates and installs a child app for the agent without pasting any keys. A5 passes | |
| D3 | Second agent | A second agent uses the existing grant and gets its own child app, with no second consent | |
| D4 | Second user | Another company member must authorize their own grant. The first user's grant is not reused | |
| D5 | Workspace requires admin approval | Installation falls back to Slack's admin approval, and the UI explains what is pending | |
| D6 | Grant revoked in Slack | The next install asks for authorization again, in plain language. Existing bots keep working or report clearly that they are disconnected | |
| D7 | Sealed events while the tenant sleeps | A message sent while the tenant is idle is delivered once after wake, and the reply arrives | |
| D8 | Remove and reinstall | Removing a managed bot clears its saved secrets and pending setup attempts, stops Cloud delivery, and keeps the user's manager grant. The child app stays in Slack; delete it separately through its Slack management URL. A fresh managed setup creates a working bot | |

## E. Distribution questions to answer with evidence

These decide whether Cloud can launch before the Slack Marketplace listing.

| # | Question | How to answer | Result |
| --- | --- | --- | --- |
| E1 | Can a workspace set to **Only allow apps from the Slack Marketplace** install a managed child app? | Turn on that setting in the test workspace and repeat D2 | |
| E2 | Do managed child apps get the non-Marketplace `conversations.history` / `conversations.replies` limits (1 request per minute, 15 messages)? | Measure C11 on a managed app, and ask our Slack contact | |
| E3 | Which approval did Slack agree to: the partner scope, a Marketplace listing, or both? | Written confirmation from our Slack contact | |
| E4 | Is each scope justified for Marketplace review? | Write a one-line justification per scope in `slack-app-manifest.ts` and `slack-tools.ts`. Move non-core tool scopes to optional or drop them | |
| E5 | Do we meet zero-copy (store metadata, not Slack content)? | Inventory what receipts, form custody, and task comments store from Slack messages | |

## Not covered here

- Marketplace listing assets (landing page, support page, privacy policy,
  screenshots, video). Track these separately once E3 is answered.
- The Slack tool connector (Slack MCP / aggregator sign-in), which has its own
  setup paths.
