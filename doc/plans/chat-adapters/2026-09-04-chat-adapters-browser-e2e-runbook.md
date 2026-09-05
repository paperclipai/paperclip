# Paperclip Chat Adapters — Live Browser E2E Runbook

**Status:** executable implementation and release acceptance contract

**Date:** 2026-09-04

**Paperclip source:** `codex/chat-adapters`; every execution records the exact tested SHA. The latest `origin/master` observed while revising this runbook was `8430bd897f01dd4b91e0970efffb71b97e5a2685`.

**Applies to:** Slack, GitHub, Microsoft Teams, and Telegram chat connections

**Companion plans:** [architecture](./2026-09-03-chat-adapters-architecture.md), [minimum setup](./2026-09-04-chat-adapters-minimum-setup-v6.md), [platform behavior](./2026-09-04-chat-adapters-platform-surfaces.md), and [UI surfaces v8](./2026-09-04-chat-adapters-ui-surfaces-v8.md)

## 1. Purpose

This is the runbook I will use to qualify each real chat adapter through its actual provider UI and the Paperclip UI. It is not a mock-only Playwright plan and it does not assume database access as proof. The browser journey must demonstrate that a provider event becomes exactly one Paperclip task, that the assigned Paperclip agent runs under normal governance, and that only safe output returns to the same provider conversation.

This document is the browser acceptance contract during implementation and the stable release gate afterward. A scenario is not complete until its visible provider state, visible Paperclip state, and durable Activity/Conversation records all agree.

The required setup path in this runbook is deliberately the path the current branch can execute. Optional provisioning paths become blocking only after they ship:

| Provider        | Required executable setup                                                                                                      | Conditional setup, test only after it ships                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Slack           | Customer-owned Slack app created from Paperclip's manifest; Bot User OAuth Token and Signing Secret entered once               | Managed **Add to Slack** OAuth installation                    |
| GitHub          | Customer-owned GitHub App; Paperclip-generated webhook secret copied to GitHub, then App ID and private key entered once       | GitHub App Manifest create-and-return exchange                 |
| Microsoft Teams | Customer-owned single-tenant Entra app, Azure Bot, and Teams app package; client ID, tenant ID, and client secret entered once | Paperclip-generated package or Teams Developer CLI/helper flow |
| Telegram        | BotFather bot token entered once                                                                                               | Managed bot provisioning                                       |

Direct public HTTPS webhooks are the required transport. A private-instance relay, Slack Socket Mode, and Telegram polling are separate conditional deployment tests; none is a choice in the endpoint wizard.

The four blocking outcomes are:

1. **Setup works:** a new chat connection can be created from `/apps` with the minimum provider-specific work.
2. **Reach is enforced:** provider installation or invitation only makes a resource available; Paperclip independently decides whether it is enabled.
3. **Identity and governance hold:** linked people use current Paperclip permissions, while allowed unlinked people remain inside the restricted external profile.
4. **Conversation integrity holds:** one external conversation maps to one task, follow-ups do not duplicate it, safe output publishes back, and all delivery state remains inspectable.

## 2. Execution model

### 2.1 What I drive in the browser

I use Codex's in-app browser with real signed-in sessions for:

- the Paperclip Connectors catalog, setup wizard, Settings, Access, Conversations, Activity, agent, and task screens;
- Slack, GitHub, Microsoft Teams, Telegram Web, and each provider's app-management or installation UI;
- every provider message, mention, reply, edit, action, file, command, and permission change in the run;
- identity-link confirmation as the mapped Paperclip user;
- screenshots and visible-state assertions at each evidence checkpoint.

The required v1 journeys stay in the browser. If Paperclip later ships a product-displayed one-time helper command, I may execute that command exactly as shown and return to the browser; I do not replace UI steps with private APIs.

### 2.2 Browser discipline

- Use accessible labels, headings, link targets, and stable test IDs rather than screen coordinates.
- Re-read the visible page after navigation, provider redirects, modal submission, or account switching before taking the next action.
- Use a separate authenticated browser profile/context for the installer, linked participant, and unlinked participant. Never switch identities in a way that leaves an ambiguous provider or Paperclip session.
- Never read secrets back from Paperclip, browser storage, cookies, or password managers. Secret entry is write-only and screenshots must show only masked values.
- Provider installation, repository grants, bot invitations, messages, file uploads, and permission changes are external side effects. Run them only in the approved sandbox resources below or under an explicit user-provided authorization envelope.
- A CAPTCHA, tenant approval, organization approval, or provider security prompt pauses the run for the user. It is not bypassed.
- Do not accept an unexpected permission request. Record the requested permission, abort that setup attempt, and fail least-privilege qualification.

### 2.3 Two complementary suites

| Suite                          |                                                              Frequency | Purpose                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic provider fixture |                                                     Every pull request | Browser coverage of Paperclip setup, Settings, Access, Conversations, Activity, task attribution, durable delivery, deduplication, and publication without external provider flakiness. |
| Real-provider browser run      | Nightly for active development; required before stable adapter release | Proves provider registration/consent, real webhook delivery, native identity, native thread/object behavior, rendering, files, actions, permission changes, and provider links.         |

A mock pass cannot replace the live-provider pass. A live-provider pass also does not replace signature, idempotency, company-boundary, or failure-injection tests below the browser layer.

Before opening a real provider, I run the deterministic Paperclip-side browser case for that provider:

```sh
pnpm exec playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/chat-adapters-ui.spec.ts \
  --grep '^Slack:'
```

Replace `Slack` with `GitHub`, `Microsoft Teams`, or `Telegram` for the other cases. A provider run begins only after its deterministic case passes. The real-provider steps themselves run in the signed-in in-app browser; Playwright fixtures never stand in for provider installation or webhook proof.

### 2.4 How I execute and record one browser case

For every numbered case, I use the same observable loop:

1. Record the case ID and start time in `result.md`.
2. Perform the provider or Paperclip action through the visible browser UI.
3. Re-read the page after each navigation, redirect, modal submission, or account change before selecting the next control.
4. Wait on a visible condition rather than using a blind delay: the provider acknowledgement, a new Conversations row, a task comment, or a terminal Activity state.
5. Open the paired Paperclip and provider records from their own links; never infer the pairing from similar text alone.
6. Capture the named screenshot with the run marker and relevant status visible. Masked secret controls may appear; secret values may not.
7. Record **PASS**, **FAIL**, or **BLOCKED — human action required**, the observed identifiers, elapsed time, and any deviation.

The normal visibility budgets are 15 seconds for provider acknowledgement or durable inbound Activity, 30 seconds for conversation/task creation, 120 seconds for the deterministic agent result, and 30 seconds for publication after the Paperclip comment is committed. Exceeding a budget triggers triage; it does not justify clicking twice or creating a second root message.

### 2.5 Browser session map and resume contract

I keep these sessions distinct for the whole run:

| Browser session      | Signed-in identity | Tabs kept open                                                   |
| -------------------- | ------------------ | ---------------------------------------------------------------- |
| Installer            | Dana E2E           | Paperclip, provider app administration, provider conversation    |
| Linked participant   | Ari E2E            | Provider conversation, Paperclip identity-link confirmation      |
| Unlinked participant | Jules E2E          | Provider conversation only until a denial or link flow is tested |

When a provider requires MFA, CAPTCHA, passkey, tenant approval, organization approval, or secret handling, I stop on that exact page and ask the user for only that browser action. I state which session and tab is waiting and the button or field that must be completed. After the user says it is ready, I re-read the current page and continue at the next uncompleted step; I do not restart setup or ask for credentials in chat.

## 3. Shared live-test environment

### 3.1 Required Paperclip fixture

Use a publicly reachable, authenticated Paperclip staging instance with real HTTPS callbacks. Name the company and run uniquely:

```text
Company: Chat Adapter E2E
Run ID: CHAT-E2E-YYYYMMDD-HHMM-<provider>
Agent: Maya E2E
```

`Maya E2E` is a deterministic test agent assigned to no production work. Its fixture contract is:

| Incoming instruction | Public behavior                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ECHO <run-id>`      | Return exactly `ACK <run-id>`.                                                                                         |
| `LONG <run-id>`      | Emit safe queued/working progress and a final response long enough to exercise native streaming or post/edit fallback. |
| `FILE <run-id>`      | Read the attached `chat-e2e.txt`, report its marker, and publish `chat-e2e-result.txt`.                                |
| `FORM <run-id>`      | Request one short text value and one choice using the richest supported interaction, then echo the submitted values.   |
| `GOVERN <run-id>`    | Create a governed Paperclip approval and publish only the provider-safe approval status/link.                          |
| `FAIL <run-id>`      | Terminate predictably after the safe working state so failure publication and retry are observable.                    |

The fixture may use a dedicated process adapter, but the incoming turn must still traverse the normal chat delivery, task, wakeup, run, and publication paths.

### 3.2 Required people

| Role                 | Paperclip identity            | Provider identity              | Purpose                                                        |
| -------------------- | ----------------------------- | ------------------------------ | -------------------------------------------------------------- |
| Installer            | Dana E2E · company admin      | Provider sandbox administrator | Creates the connection and changes Settings/Access.            |
| Linked participant   | Ari E2E · ordinary member     | Separate provider member       | Confirms identity linking and current Paperclip authorization. |
| Unlinked participant | Jules E2E · no Paperclip link | Separate provider member       | Exercises restricted external access and link-required denial. |

The provider bot identity is dedicated to `Maya E2E`. It must not share a native bot identity with another Paperclip agent endpoint.

### 3.3 Resource naming and isolation

All resources must be disposable or explicitly designated for Paperclip testing:

| Provider | Available/enabled fixture                | Available/disabled fixture          |
| -------- | ---------------------------------------- | ----------------------------------- |
| Slack    | `#pc-e2e-enabled`                        | `#pc-e2e-disabled`                  |
| GitHub   | `paperclip-chat-e2e-enabled`             | `paperclip-chat-e2e-disabled`       |
| Teams    | `Paperclip Chat E2E / Enabled`           | `Paperclip Chat E2E / Disabled`     |
| Telegram | `Paperclip Chat E2E Enabled` group/forum | `Paperclip Chat E2E Disabled` group |

Include the run ID in every root message, issue, pull request, task, file body, and screenshot filename. Never run in a production workspace, tenant, organization, repository, team, group, or channel.

### 3.4 Evidence bundle

For each provider, save:

```text
test-results/chat-adapters-live/<run-id>/<provider>/
├── 01-connected.png
├── 02-settings-reach.png
├── 03-provider-conversation.png
├── 04-paperclip-task.png
├── 05-access.png
├── 06-conversations.png
├── 07-activity.png
├── 08-negative-reach.png
├── 09-capabilities.png
└── result.md
```

`result.md` records the Paperclip base SHA, adapter/Chat SDK version, provider app/bot identity, provider tenant/workspace/org identifier in redacted form, endpoint ID, external conversation identifier, task identifier, delivery/publication identifiers, pass/fail for every numbered case, deviations, and cleanup result. It contains no token, signing secret, private key, client secret, cookie, or one-time identity-link URL.

### 3.5 Shared preflight

Before starting a provider run:

1. Confirm Paperclip health and sign in as Dana E2E.
2. Confirm `Maya E2E` is active and that its deterministic fixture contract passes from an ordinary Paperclip task.
3. Confirm the provider installer, Ari, and Jules browser sessions are signed into the intended sandbox accounts.
4. Confirm the provider test resources contain no production data and that prior run messages/issues can be distinguished by run ID.
5. Confirm the Paperclip instance is publicly reachable for direct verified webhooks. Relay qualification is a separate deployment run described in section 9.
6. Confirm the connection does not already exist. If it does, remove the stale test connection through the UI and verify its historical tasks remain readable before creating the new connection.
7. Start browser recording/screenshots before `/apps`; record the Paperclip SHA and current time.

### 3.6 Human login and credential handoffs

I drive every unblocked browser step myself. I pause and ask the user only at these boundaries:

| Provider        | Human action that may be required                                                                                                            | What I do immediately afterward                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Slack           | Sign in to the sandbox workspace, approve installation, or paste the customer-owned bot token/signing secret into Paperclip's masked fields. | Resume at the Slack consent result, verify the requested scopes, invite the bot, and execute S1–S7. |
| GitHub          | Sign in to the sandbox organization, approve App creation/installation, or upload a newly generated private key for the manual path.         | Verify the repository grant and permissions, then execute G1–G7.                                    |
| Microsoft Teams | Sign in to the test tenant, satisfy tenant-admin consent, or enter the client secret in Paperclip's masked field.                            | Verify the created bot/app identity and install target, then execute T1–T7.                         |
| Telegram        | Sign in to Telegram Web or copy the BotFather token into Paperclip's masked field.                                                           | Verify the bot identity with the provider, then execute TG1–TG6.                                    |

CAPTCHA, passkey, MFA, organization approval, tenant approval, and secret entry remain user-controlled. I never ask the user to send a credential in chat, and I never copy a secret into test evidence. A pause records the exact browser page and the single action needed so the run can resume without repeating completed setup.

### 3.7 Execution order and result rule

Run the providers in this order unless a provider outage makes another order more efficient: Slack, GitHub, Microsoft Teams, then Telegram. For each provider:

1. complete Shared Preflight;
2. perform the normal first-time setup path;
3. execute C1–C7 through the provider-specific steps;
4. execute that provider's recovery case;
5. save and inspect its evidence bundle;
6. clean up only the disposable external resources named by the runbook; and
7. mark the provider **PASS**, **FAIL**, or **BLOCKED — human action required**.

Do not call a provider passed based on a subset of capabilities. A blocked human login does not erase earlier evidence, and a provider failure does not prevent running the other providers.

## 4. Shared assertions for every provider

Run these assertions within each platform-specific procedure.

### C1 — Catalog and immutable agent

1. Open `/<company>/apps` and find the provider.
2. Click **Connect**.
3. If the provider supports chat and tools, choose **Chat with an agent**. Verify the alternative says **Use this connection as an agent tool**.
4. Choose `Maya E2E` with the standard agent selector.
5. Complete provider setup.
6. On every post-connect tab, verify Maya is shown only as connection context and there is no change-agent control.

**Pass:** one endpoint exists for Maya; changing the agent is impossible. Connecting another agent would require another connection.

### C2 — Provider availability versus Paperclip enablement

1. Make both provider fixtures available to the bot through the provider UI.
2. Open connector **Settings**.
3. Verify the setup-test destination is enabled and the second discovered destination is visible but disabled.
4. From Jules, address the bot in the disabled destination using a unique run marker.
5. Wait beyond the normal event-to-acknowledgement window, then inspect Paperclip Conversations, Tasks, and Activity.

**Pass:** the provider may deliver the event, but Paperclip creates no task, wakes no agent, and publishes no response. Activity records an ignored delivery with safe metadata. After Dana enables the destination and repeats with a new marker, exactly one task is created.

### C3 — Linked and unlinked identity

1. With **Allow unlinked people** enabled, have Jules create work in an enabled destination.
2. Open the task and verify the comment is attributed as an external unlinked identity.
3. Trigger `GOVERN <run-id>` and attempt the governed action as Jules.
4. Verify the provider shows a private or concise safe denial/link and Paperclip records a denied authorization. The approval remains unresolved.
5. In **Access**, create an identity link for Ari. Open the one-time link in Ari's Paperclip browser session, verify both identities/company, and confirm.
6. Have Ari create or continue work. Verify the task attributes Ari as the linked Paperclip user.
7. Revoke Ari's link in Access and repeat an action.
8. Turn **Allow unlinked people** off and address the bot as Jules.

**Pass:** linked authority is current rather than cached; revocation is immediate. Unlinked access can converse only when enabled, never crosses governance boundaries, and creates no task when unlinked participation is disabled.

### C4 — One conversation, one task

1. Start a new provider-native conversation with `ECHO <run-id>-A`.
2. Open connector **Conversations** and record its task identifier.
3. Send two follow-ups, the second without another mention where the provider contract permits.
4. Open the provider-specific link (**Open Slack**, **Open GitHub**, **Open Microsoft Teams**, or **Open Telegram**) and **Open task** from the same row.
5. Confirm all turns appear in the same external conversation and same task, in order.
6. Start a genuinely new provider-native conversation with marker `ECHO <run-id>-B`.

**Pass:** the first conversation still has one task; the second has a different task. There are no duplicate tasks or conversation rows.

### C5 — Safe publication and internal-only content

1. Run `LONG <run-id>` and observe the provider while Maya works.
2. In the Paperclip task, add board comment `INTERNAL-<run-id>` without **Send to channel**.
3. Confirm it never appears at the provider.
4. Add `PUBLIC-<run-id>` with **Send to channel** selected.
5. Confirm it appears once in the bound provider conversation with delivered status in Paperclip.
6. Inspect provider output for chain-of-thought, raw tool arguments, credentials, internal logs, hidden comments, or private artifact URLs.

**Pass:** only safe milestones/final output and explicit board publication leave Paperclip. No internal material is exposed.

### C6 — Files, interactions, concurrency, edits, and failure

1. Upload `chat-e2e.txt` containing only `FILE-MARKER <run-id>` and send `FILE <run-id>`.
2. Verify Paperclip stores a bounded normal attachment, Maya reads the marker, and the result file is reachable through a provider-supported upload or expiring Paperclip link.
3. Send `FORM <run-id>` and complete the richest provider-supported action/form. Verify the submitted values reach the existing task exactly once.
4. Send `ECHO <run-id>-Q1` and `ECHO <run-id>-Q2` rapidly in the same conversation.
5. Verify default queue order in the task and publications.
6. Edit one human provider message, then delete another test message.
7. Verify Paperclip appends a correction/tombstone rather than rewriting audit history.
8. Where the provider emits reaction callbacks, add and then remove a reaction on a linked test message. Verify Activity records both events, while the task receives no new comment, wakeup, approval, or governed action.
9. Send `FAIL <run-id>`, verify the safe failed state, then use the authorized retry action from Activity.

**Pass:** every supported native feature is used. Unsupported features follow the adapter's documented text/link/private fallback. Inputs apply once, queued turns retain order, edits/deletes and reactions remain auditable, reactions are never interpreted as authority, and retry does not duplicate task state or provider output.

### C7 — Management surfaces

1. Open Settings, Access, Conversations, and Activity from the connector sidebar.
2. Verify Settings contains only provider-available destination enablement and applicable DM/group-chat toggles.
3. Verify Access contains only the unlinked-participation choice and linked accounts.
4. Verify Conversations is one list with external conversation, task, state, a provider-specific **Open …** link, and **Open task**.
5. Verify Activity exposes connection health, delivery/publication states, deduplication, redacted failures, and only contextual repair/replay actions.
6. Open Maya's **Channels** view and the externally connected task banner.

**Pass:** no Overview tab, task-boundary settings, delivery-path selector, capability toggles, sponsor selector, manual binding actions, or agent reassignment control appears.

## 5. Slack live browser runbook

### Slack prerequisites

- Dedicated Slack developer workspace containing Dana, Ari, and Jules.
- Permission to install a Paperclip Slack app and invite it to the two test channels.
- Direct-message access enabled for the test workspace.
- Managed **Add to Slack** path when available. The prepared customer-owned App Manifest path is the required baseline and is qualified for every stable release and after any manifest/scope change.

### S1 — Required customer-owned Slack App setup

Run this for every stable release, after any Slack manifest/scopes/events change, and for self-hosted release candidates:

1. In Paperclip, perform C1 and select Slack.
2. On **Connect a Slack app**, copy the generated manifest and open Slack app settings.
3. In Slack, choose **Create New App** → **From an app manifest**, select only the sandbox workspace, paste the manifest, and inspect its bot scopes before clicking **Create**. Abort if Slack shows scopes beyond the versioned Paperclip manifest.
4. Open **OAuth & Permissions**, click **Install to Workspace**, review the consent page, approve it, and copy the **Bot User OAuth Token** into Paperclip's masked field.
5. Open **Basic Information**, reveal the **Signing Secret**, and paste it directly into Paperclip's masked field. Do not capture either secret.
6. Click **Connect Slack app**. Paperclip verifies the token and advances to **Finish Slack setup**.
7. Return to the App's **App Manifest** page in Slack and click **Save Changes** once. The manifest already contains the webhook URL, event subscriptions, interactivity URL, slash command, and command URL. Wait for Slack to accept and verify the saved manifest; do not recreate those settings manually.
8. Return to Paperclip and click **Start Slack message test**.
9. Open `#pc-e2e-enabled`, use `/invite @Maya` if needed, then post `@Maya ECHO <run-id>-SETUP` as a new channel message.
10. Verify Maya responds in a thread. Reply `ECHO <run-id>-SETUP-REPLY` inside that thread without mentioning Maya.
11. Return to Paperclip, click **I've sent the test message** once, and verify Settings opens with `#pc-e2e-enabled` enabled.

**Pass:** the two write-only secrets are the only credential inputs; one manifest save configures and verifies all callback surfaces; the real root mention and unmentioned bound-thread reply complete setup; the tested channel is enabled.

### S2 — Conditional managed Add to Slack setup

Run only after a managed **Add to Slack** control ships:

1. Start a separate disposable endpoint and click **Add Maya to Slack**.
2. Select only the sandbox workspace, inspect the requested scopes, approve installation, and return to Paperclip.
3. Complete the same root-mention/thread-reply setup test from S1.

**Pass:** no token or signing-secret field appears, the endpoint owns a distinct Slack bot identity, and the provider behavior is identical to S1. Until this control exists, record S2 as **NOT SHIPPED — NON-BLOCKING**, not failed.

### S3 — Channel reach

1. Invite Maya to `#pc-e2e-disabled` in Slack.
2. Refresh Slack Settings in Paperclip if discovery is not pushed immediately.
3. Verify the row says invited/available but is off.
4. Run C2.
5. Remove Maya from that Slack channel and refresh.

**Pass:** Slack membership is the provider ceiling. Paperclip's toggle is the independent allowlist. Removal marks the row unavailable and blocks new work without erasing the previous task row.

### S4 — Hermes thread behavior

1. Post `@Maya ECHO <run-id>-ROOT` as a new channel root.
2. Verify Maya's first response is under that root and the channel timeline contains no separate bot message.
3. Reply twice inside the thread without mentioning Maya. Run C4.
4. Post a fresh root without a mention. Verify silence and no task.
5. Create a human-only thread, add one earlier reply, then mention Maya inside it with `ECHO <run-id>-CLAIM`.

**Pass:** the root/thread maps to one task; subscribed replies continue it; fresh unaddressed roots are ignored; an existing thread binds from the first mention without importing earlier messages.

### S5 — Slack capabilities

Run C5 and C6, then verify specifically:

- acknowledgement uses the approved reaction or a concise threaded receipt;
- safe output uses Slack native streaming when available, otherwise one post edited at a bounded cadence;
- `FORM` uses Block Kit buttons/selects and a modal for the text field; modal submission applies once;
- files ingest and publish without exposing Paperclip credentials;
- an unauthorized response uses an ephemeral message, with DM/text fallback only when ephemeral delivery fails;
- In the bot DM, the registered agent command with `status` returns the active task state; `new` advances the DM to a fresh task generation and `close` closes the active one. In a channel, Slack does not include a thread timestamp in slash-command payloads, so these controls return private guidance to use the task link in the native thread rather than guessing among channel tasks;
- custom emoji failure falls back to a standard supported emoji;
- a duplicated Slack retry is deduplicated and visible in Activity.

### S6 — Slack DMs and recovery

1. Toggle **Allow direct messages** off and message Maya from Ari. Verify no task or agent wakeup.
2. Turn it on. Send `ECHO <run-id>-DM1`, then a follow-up; confirm one open DM task.
3. Complete that task in Paperclip and send `ECHO <run-id>-DM2`; confirm a new task.
4. Pause the connection; address Maya in an enabled channel; verify no new run/publication.
5. Resume and send a new marker; verify recovery.
6. For the scheduled recovery qualification, revoke or uninstall only the disposable Slack app, verify Activity shows the contextual reconnect/reinstall action, then repair it.

### S7 — Slack evidence and cleanup

Capture all shared evidence plus the Slack OAuth scope screen, thread, DM lifecycle, modal, file, disabled-channel result, Conversations row, and deduplicated delivery. Remove the disposable custom App, delete test messages/channels only when the sandbox cleanup policy allows it, revoke identity links, and remove the Paperclip test connections through the UI. Preserve Paperclip tasks/activity for audit unless the whole E2E company is designated disposable.

## 6. GitHub live browser runbook

### GitHub prerequisites

- Dedicated GitHub test organization with Dana as App installer and Ari/Jules as members.
- Two repositories named in section 3.3, containing no production code.
- One seeded pull request with at least two changed lines so inline review-thread activation can be tested.
- Permission to create and delete GitHub Apps in the test organization.

### G1 — Required customer-owned GitHub App setup

Run before stable release and after any GitHub permission, event, or identity change:

1. In Paperclip, perform C1 and select GitHub → **Chat with an agent**.
2. On **Create or connect a GitHub App**, copy the Paperclip webhook URL and open GitHub App settings.
3. In the sandbox organization, open **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
4. In Paperclip, click **Generate webhook secret**. Copy the one-time value immediately, then enter the Paperclip webhook URL and generated secret in GitHub with the webhook active and SSL verification enabled. Paperclip must show only the configured state after refresh. If **Regenerate webhook secret** is used, update GitHub before expecting another webhook to verify.
5. Under repository permissions, set **Metadata: read**, **Issues: read and write**, and **Pull requests: read and write**. Leave Contents, Actions, Administration, and organization permissions at **No access**.
6. Subscribe only to the selectable **Issue comment** and **Pull request review comment** events. GitHub sends **Installation** and **Installation repositories** to every GitHub App automatically, so they do not appear as subscription controls. Save the App.
7. Copy the numeric **App ID** into Paperclip. Under **Private keys**, generate a key, open the downloaded PEM locally, and paste it into Paperclip's write-only private-key field without recording or screenshotting it.
8. In GitHub, click **Install App**, select the sandbox organization, choose **Only select repositories**, and grant the two test repositories.
9. Return to Paperclip and click **Connect and verify**. Paperclip must verify the App identity without displaying the secret or private key again.
10. In `paperclip-chat-e2e-enabled`, open a new issue titled `<run-id> setup`, comment `@<verified-bot-login> ECHO <run-id>-SETUP`, then add an unmentioned follow-up comment.
11. Return to Paperclip, run the setup test once, and verify Settings opens with the tested repository enabled and the second installation repository disabled.

**Pass:** Paperclip generates and stores the webhook secret, returns it only once for copying to GitHub, and asks the operator to enter only App ID and private key; least-privilege repository permissions are visible in GitHub; the real issue conversation completes setup; no PAT is used.

### G2 — Conditional GitHub App Manifest setup

Run only after Paperclip ships a **Create in GitHub** manifest exchange:

1. Start a separate disposable endpoint and click **Create in GitHub**.
2. Choose the sandbox organization, inspect the prefilled webhook/events/permissions, create the App, and return through GitHub's temporary-code callback.
3. Install it on only the two test repositories and complete the G1 issue-conversation test.

**Pass:** Paperclip exchanges the one-time code server-to-server and never asks the operator to paste App ID, private key, or webhook secret. Until this control exists, record G2 as **NOT SHIPPED — NON-BLOCKING**, not failed.

### G3 — Repository reach

1. Run C2 with the disabled repository.
2. In GitHub App installation settings, remove the disabled repository while Paperclip has it enabled.
3. Return to Settings and refresh.

**Pass:** GitHub installation selection is the provider ceiling; Paperclip is the narrower enablement layer. Removed repository access becomes unavailable and no new work occurs there.

### G4 — GitHub conversation boundaries

1. In an enabled repository issue, mention Maya and run C4 using ordinary issue comments.
2. In the seeded pull request's main conversation, mention Maya and record the Paperclip task.
3. In an inline review comment, mention Maya with another marker and record its task.
4. Add unmentioned follow-ups to the PR conversation and inline review thread.

**Pass:** one issue, one PR conversation, and one inline review thread each have one task. The PR-level and inline-review tasks are distinct even within the same PR.

### G5 — GitHub capabilities and separation from tool access

Run C5 and C6 with GitHub-specific expectations:

- acknowledgement uses a supported reaction;
- long output is one GFM comment updated at a coarse cadence, not a stream of noisy comments;
- provider edits preserve a stable message link and final content;
- rich actions/forms fall back to explanatory text plus an authenticated Paperclip link;
- inbound GitHub attachment links are fetched only through bounded, type-checked ingestion;
- outbound files use safe links when native upload is unavailable;
- there is no DM, ephemeral, modal, or native button claim in the UI;
- asking Maya to inspect or change repository code does not grant access. Without a separate GitHub tool connection, Maya returns a safe limitation/link and no code operation occurs.

### G6 — Identity, redelivery, suspension, and recovery

1. Run C3 using GitHub numeric user identities.
2. Open the App's **Recent deliveries**, choose the setup webhook, and use GitHub's redelivery action once.
3. Verify Activity marks the duplicate delivery and neither the task nor bot comment duplicates.
4. Suspend or uninstall only the disposable App installation.
5. Verify Activity and Settings show unavailable resources with a contextual repair action.
6. Reinstall/unsuspend and send a new marker.

**Pass:** recovery uses the existing endpoint and does not alter old conversation/task links.

### G7 — GitHub evidence and cleanup

Capture the App permission screen, selected repositories, issue/PR/review conversations, reaction/edit behavior, fallback link, Conversations rows, duplicate delivery, and unavailable/recovered state. Close test issues/PRs, delete uploaded fixture files where applicable, delete the disposable GitHub App, revoke identity links, and remove the Paperclip connection. Never delete a repository unless the authorization envelope explicitly names it as disposable.

## 7. Microsoft Teams live browser runbook

### Teams prerequisites

- Dedicated Microsoft 365 developer tenant with Dana as permitted app installer and Ari/Jules as members.
- Team `Paperclip Chat E2E` with the Enabled and Disabled channels.
- Permission to create an Entra application and Azure Bot. A future guided helper is optional and does not gate the required customer-owned setup path.
- Tenant policy that permits custom-app upload/install, or a test administrator available to approve it.

### T1 — Required customer-owned Microsoft setup

Run before stable release and after identity, Teams manifest, or permission changes:

1. In Paperclip, perform C1 and select Microsoft Teams. Keep **Connect Maya to Microsoft Teams** open and copy the displayed Paperclip messaging endpoint.
2. In the sandbox tenant's Microsoft Entra admin center, create a **single-tenant** app registration. Record its Application (client) ID and Directory (tenant) ID, create one client secret, and keep the secret value available only for immediate entry.
3. In Azure, create an **Azure Bot** using that existing Application ID and the single-tenant identity type. Set its messaging endpoint to Paperclip's displayed URL and enable its Microsoft Teams channel.
4. In Teams Developer Portal, create a Teams app for this bot. Add a bot using the same Application ID and enable Personal, Team, and Group chat scopes.
5. Add the resource-specific permissions required by the shipped manifest: `ChannelMessage.Read.Group` for subscribed channel-thread replies and `ChatMessage.Read.Chat` for group-chat messages. Do not grant tenant-wide directory/history permissions.
6. Publish the Teams app to the sandbox organization or download and upload its app package according to tenant policy.
7. Return to Paperclip. Enter only Application/Client ID, Directory/Tenant ID, and the client-secret value, then click **Verify Microsoft credentials**. Confirm the secret remains masked and is not shown again.
8. In Teams, open the app installation surface, click **Add**, and install it into `Paperclip Chat E2E` and personal scope when prompted.
9. In the Enabled channel, create a new post containing `@Maya ECHO <run-id>-SETUP`, then reply beneath it without another mention.
10. Return to Paperclip, run the setup test once, and verify Settings opens with the tested channel enabled.

**Pass:** only the three portable identity values are requested; the messaging endpoint and Teams app are correctly wired; the real post/reply conversation completes setup; no delivery-mode or cloud-strategy choice appears.

### T2 — Conditional guided Microsoft setup

Run only after Paperclip ships a generated package or one-time Teams Developer CLI/helper flow:

1. Start a separate disposable endpoint and use the one guided setup control shown by Paperclip.
2. Complete Microsoft sign-in in the browser, restricting creation and consent to the sandbox tenant.
3. Install the generated app into the test team and complete the T1 post/reply setup test.

**Pass:** the helper creates only the documented Entra/Azure Bot/Teams app resources and Paperclip does not expose a credential form. Until a helper exists, record T2 as **NOT SHIPPED — NON-BLOCKING**, not failed.

### T3 — Team/channel reach

1. Verify installation at the provider is scoped to the test team.
2. In Paperclip Settings, confirm both team channels are available but only Enabled is on.
3. Run C2 in the Disabled channel.
4. Install Maya into a second disposable test team, refresh, and verify its channels appear disabled.
5. Remove the app from that second team and verify unavailable state.

**Pass:** Teams app installation is the provider ceiling; Paperclip independently enables individual channels.

### T4 — Channel threads and delivery grant

1. In Enabled, start a new channel post with `@Maya ECHO <run-id>-ROOT`.
2. Confirm Maya replies beneath that post and one Paperclip task is created.
3. Reply without mentioning Maya.
4. Verify the same task continues without another mention. If the reply is not delivered, setup is not qualified: repair the app manifest/RSC consent and reinstall or upgrade the Teams app before continuing.
5. Start an unrelated unmentioned channel post and verify no task.
6. Run C4 under the required subscribed-thread behavior.

**Pass:** the required manifest/RSC grant delivers the unmentioned bound-thread reply, while unrelated unmentioned posts remain ignored. There is no user-configurable weaker reply mode.

### T5 — Personal and group chats

1. Install/open Maya in personal scope if Microsoft requires it.
2. Toggle **Allow direct messages** off; message Maya and verify no task. Turn it on and verify one open DM task.
3. Complete the DM task and send a new message; verify a new task.
4. Add Maya to a disposable group chat while **Allow group chats** is off; verify no task.
5. Enable group chats and repeat with a new marker.

**Pass:** provider installation makes each surface available; Paperclip's DM/group settings control eligibility.

### T6 — Teams capabilities

Run C3, C5, and C6, then verify specifically:

- DM uses native streaming when the adapter and tenant support it;
- channel/group output uses bounded buffered or edit behavior rather than claiming unsupported native streaming;
- `FORM` uses an Adaptive Card and task module where supported, with server-side reauthorization on submit;
- files are downloaded through authenticated, bounded ingestion and safely returned;
- denials use targeted activity when supported, otherwise DM or concise text plus a Paperclip link;
- tenant ID plus Entra object ID, not display name/email, determines identity;
- app removal, consent revocation, or invalid bot identity appears in Activity with the correct repair action.

### T7 — Teams evidence and cleanup

Capture Microsoft consent/install scope, Enabled/Disabled behavior, channel thread, reply-permission mode, DM/group behavior, Adaptive Card/task module, Conversations rows, and Activity repair state. Remove the disposable app from extra teams and chats, delete the test app registration/Azure Bot only when created for this run, revoke identity links, and remove the Paperclip connection. Do not delete the shared developer tenant or baseline team.

## 8. Telegram live browser runbook

### Telegram prerequisites

- Dedicated Telegram accounts for Dana, Ari, and Jules.
- Permission to create/delete disposable BotFather bots or a pre-provisioned dedicated bot for routine smoke runs.
- Enabled and Disabled test groups; Enabled should support forum topics for topic-boundary testing.
- No personal or production messages in the test chats.

### TG1 — BotFather setup

For a first-time provisioning qualification:

1. In Paperclip, perform C1 and select Telegram.
2. Click **Open BotFather**.
3. In Telegram Web, send `/newbot`, enter `Maya E2E <run suffix>`, and choose a unique username ending in `bot`.
4. Copy the returned bot token directly into Paperclip's masked write-only field. Do not screenshot or record it.
5. Click **Connect**.
6. Open the bot's private chat, click **Start**, and send `ECHO <run-id>-SETUP`.
7. Return to Paperclip and verify setup completes with direct messages enabled.

For routine nightly smoke, reuse a dedicated pre-provisioned bot but create a fresh Paperclip connection. Never attach the same bot token to two active endpoints.

**Pass:** the BotFather token is the only normal credential input. Webhook/relay/polling and token-rotation choices do not appear in setup.

### TG2 — Group and topic reach

1. Add Maya to both test groups through Telegram.
2. Send one addressed discovery message in each if required by Telegram before Paperclip can learn the chat identifier.
3. Open Paperclip Settings. Verify both groups are available and Disabled remains off.
4. Run C2 in the Disabled group.
5. In Enabled, create/open forum topic `Run <run-id>` and enable that topic in Settings if topics are listed separately.
6. Remove Maya from Disabled and verify unavailable state.

**Pass:** Telegram membership/discovery is the provider ceiling. Paperclip enables the narrower set of groups/topics.

### TG3 — DM, ordinary group, and forum boundaries

1. In DM, send `ECHO <run-id>-DM1` and two follow-ups; verify one open task.
2. Send `/new`, then `ECHO <run-id>-DM2`; verify a new task. Send `/close`, then another message; verify the next task generation.
3. In Enabled ordinary group, mention `@MayaBot ECHO <run-id>-GROUP`.
4. Continue once by replying directly to Maya and once with another mention.
5. Send an unrelated group message; under privacy mode, verify it is not processed.
6. In the forum topic, address Maya and add follow-ups; run C4.

**Pass:** DM/ordinary group uses an explicit active-task generation; forum `message_thread_id` has one stable topic task; privacy-mode unrelated traffic creates nothing.

### TG4 — Telegram capabilities

Run C3, C5, and C6, then verify specifically:

- Telegram shows typing/reaction acknowledgement where allowed;
- long output uses throttled post/edit, and private draft preview only when explicitly supported by the adapter/account;
- `FORM` uses inline keyboard buttons; fields that require a modal fall back to a Paperclip link or sequential prompts;
- `/new`, `/status`, and `/close` are parsed as the documented small command vocabulary;
- image/document/media ingestion is bounded and type checked;
- there is no claim of true ephemeral output; a private denial uses DM when possible or concise safe text;
- callback data contains only an opaque short key and every click reauthorizes the Telegram principal;
- flood-control retry honors provider timing and produces one final message.

### TG5 — Token/webhook recovery

Run only against a disposable bot or scheduled credential-rotation fixture:

1. Rotate/revoke the bot token in BotFather.
2. Verify Activity shows an invalid-token repair action and no secret value.
3. Enter the replacement token through reconnect.
4. Send a new marker and verify the existing endpoint recovers without changing historical task links.
5. Verify direct verified webhook health. Polling is qualified only in the separate instance-admin developer-mode run, never as an endpoint choice.

### TG6 — Telegram evidence and cleanup

Capture the masked token step, DM setup proof, group disabled/enabled states, forum topic, inline keyboard, file/media behavior, active-task transitions, Conversations rows, flood-control/recovery evidence, and Activity state. Remove the bot from disposable groups, delete the disposable BotFather bot when authorized, revoke identity links, and remove the Paperclip connection. Never include the token in screenshots or results.

## 9. Cross-platform deployment qualification

Run once per release candidate in addition to the provider runbooks.

### D1 — Direct webhook

Use the public staging instance for each provider. Verify provider callback verification, first delivery, duplicate delivery, and Activity health. No endpoint-level delivery choice may appear.

### D2 — Private self-hosted relay

Run only after the relay is shipped. Until then, record D2 as **NOT SHIPPED — NON-BLOCKING** and do not expose relay as an endpoint setup option.

1. Start a private Paperclip instance with no inbound public route.
2. Configure the authenticated relay once in instance administration.
3. Create one disposable chat endpoint and complete the provider's normal browser setup without choosing relay in the endpoint wizard.
4. Send a provider message and verify relay heartbeat, verified provider signature, task creation, output publication, reconnect after a brief offline period, and fenced single-consumer behavior.
5. Rotate the relay key from instance administration and verify endpoint continuity.

**Pass:** the provider journey is unchanged; relay is instance transport, not endpoint configuration. The relay cannot act as a Paperclip user or invoke arbitrary APIs.

### D3 — Provider developer escape hatches

Slack Socket Mode and Telegram polling receive separate instance-admin smoke tests only when shipped. The endpoint setup and Settings pages must remain unchanged. These modes do not count as substitutes for direct-webhook or relay qualification.

## 10. Provider capability acceptance matrix

“Automatic” means the richest safe native behavior is used without an endpoint toggle. “Fallback” means the provider visibly receives the documented safe alternative.

| Capability               | Slack                         | GitHub                          | Teams                                  | Telegram                               |
| ------------------------ | ----------------------------- | ------------------------------- | -------------------------------------- | -------------------------------------- |
| Root activation          | Native mention                | Mention in issue/PR/review      | Native mention                         | DM message or group mention/reply      |
| Durable boundary         | Slack thread or DM generation | Existing issue/PR/review thread | Channel post thread or chat generation | Chat generation or forum topic         |
| Reaction acknowledgement | Automatic                     | Automatic                       | Automatic where supported              | Automatic where allowed                |
| Streaming/progress       | Native stream, else post/edit | Coarse comment edit             | Native in DM; buffered/edit elsewhere  | Throttled post/edit; optional DM draft |
| Rich cards               | Block Kit                     | GFM + Paperclip link            | Adaptive Card                          | Formatted text/inline keyboard         |
| Buttons/selections       | Native                        | Fallback link                   | Native card action                     | Inline keyboard                        |
| Modal/form               | Native modal                  | Fallback link                   | Task module                            | Sequential prompt/link fallback        |
| Commands                 | Registered slash command      | Text mention vocabulary only    | Card/message vocabulary                | `/new`, `/status`, `/close`            |
| Files                    | Native send/receive           | Ingest link + safe output link  | Native send/receive                    | Native media/document                  |
| DM                       | Native                        | Unsupported                     | Personal scope                         | Native                                 |
| Ephemeral/private denial | Ephemeral, then DM/text       | Safe public text/link           | Targeted, then DM/text                 | DM, then safe text                     |
| Edit/delete audit        | Correction/tombstone          | Correction/tombstone            | Correction/tombstone where delivered   | Correction/tombstone where delivered   |
| Concurrent turns         | Queue by default              | Queue by default                | Queue by default                       | Queue by default                       |

A stable adapter fails qualification if it silently omits a supported maximal feature, exposes a feature toggle that should be automatic, claims an unsupported native behavior, or falls back without preserving task identity, authorization, and safe publication.

## 11. Failure triage

When any step fails, stop advancing that scenario and capture:

1. visible provider state and current URL;
2. visible Paperclip state and current URL;
3. run ID, endpoint, resource, conversation, task, delivery, and publication identifiers available in the UI;
4. the last successful step and exact failed expectation;
5. redacted Activity error and provider request/delivery status;
6. whether retry would create an external side effect.

Classify the failure before retrying:

| Class                | Examples                                                    | Retry rule                                                                         |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Setup/permission     | denied install, missing scope, tenant policy                | Do not broaden permission. Correct the documented prerequisite or fail.            |
| Ingress              | invalid signature, callback unreachable, duplicate delivery | Repair transport/provider config, then redeliver the same fixture once.            |
| Reach/auth           | disabled resource acted, unlinked user governed             | Security failure; do not continue qualification.                                   |
| Binding/idempotency  | duplicate task, wrong thread, duplicate publication         | Data-integrity failure; preserve evidence and stop.                                |
| Rendering/capability | broken card, unsupported stream claim                       | Record capability/fallback mismatch, then test the documented fallback separately. |
| Provider transient   | rate limit, temporary outage                                | Wait for the provider-specified retry window; do not spam retry.                   |

Never “fix” a failing run by manually editing a task, changing the assigned agent, enabling a broader provider permission, deleting the duplicate evidence, or bypassing Paperclip's Settings/Access enforcement.

## 12. Final sign-off checklist

A provider is release-ready only when all are true:

- [ ] Normal first-time setup passed through the real provider UI.
- [ ] Every setup mode actually shipped and promised for that provider passed; conditional unshipped modes are recorded as non-blocking.
- [ ] Requested provider permissions matched the pinned least-privilege contract.
- [ ] Provider-available versus Paperclip-enabled reach passed, including the disabled-resource negative case.
- [ ] Linked, revoked, allowed-unlinked, unlinked-disabled, and governance-denied cases passed.
- [ ] Native conversation boundaries produced exactly one task each.
- [ ] Follow-ups, new conversations, DMs/linear generations, and existing-thread/object behavior matched the platform contract.
- [ ] Maximum safe native capabilities and every required fallback passed.
- [ ] Files, actions/forms, concurrency, edits/deletes, failure, retry, and deduplication passed.
- [ ] Internal-only content remained internal; explicit **Send to channel** published once.
- [ ] Settings, Access, Conversations, Activity, Agent Channels, and externally connected task surfaces agreed.
- [ ] The provider-specific **Open …** link and **Open task** navigated to the correct pair for every sampled row.
- [ ] Pause/resume and scheduled revoke/uninstall/reconnect behavior passed without losing history.
- [ ] Evidence bundle contains no credentials, tokens, cookies, personal data, or production content.
- [ ] Cleanup completed and retained audit history is intentional.

The final result is **PASS** only when all blocking checks pass on the same Paperclip SHA and adapter version. A conditional provider fallback is acceptable only when the UI advertised that exact fallback before the user depended on the unavailable native behavior.

## 13. Provider operator references

These official references are the browser runner's drift checks when a provider renames or moves a setup control. The permissions and events displayed by the versioned Paperclip setup remain the test's exact least-privilege contract; a changed provider UI is not permission to grant more access.

- Slack: [app manifests](https://api.slack.com/reference/manifests), [Events API](https://api.slack.com/apis/connections/events-api), and [slash commands](https://api.slack.com/tutorials/your-first-slash-command).
- GitHub: [modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration), [managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), [installing and scoping GitHub Apps](https://docs.github.com/en/apps/using-github-apps/about-using-github-apps), and the conditional [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
- Microsoft Teams: [Azure bot configuration](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/teams/azure-configuration), [bot surfaces](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/design/bots), and [RSC channel/chat delivery](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents).
- Telegram: [bot creation and privacy behavior](https://core.telegram.org/bots) and [Bot API webhook behavior](https://core.telegram.org/bots/api#setwebhook).
