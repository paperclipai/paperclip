# Paperclip Chat Adapters — Live Browser E2E Runbook

**Status:** executable implementation and release acceptance contract

**Date:** 2026-09-04

**Paperclip source:** `codex/chat-adapters`; every execution records the exact tested SHA and contemporaneous `origin/master` revision in its qualification result. The runbook itself is revision-independent and must not be read as proof for whichever commit happens to be current.

**Applies to:** Slack, GitHub, Discord, Microsoft Teams, and Telegram chat connections

**Companion plans:** [architecture](./2026-09-03-chat-adapters-architecture.md), [minimum setup](./2026-09-04-chat-adapters-minimum-setup-v6.md), [platform behavior](./2026-09-04-chat-adapters-platform-surfaces.md), and [UI surfaces v8](./2026-09-04-chat-adapters-ui-surfaces-v8.md)

## 1. Purpose

This is the runbook I will use to qualify each real chat adapter through its actual provider UI and the Paperclip UI. It is not a mock-only Playwright plan and it does not assume database access as proof. The browser journey must demonstrate that a provider event becomes exactly one Paperclip task, that the assigned Paperclip agent runs under normal governance, and that only safe output returns to the same provider conversation.

This document is the browser acceptance contract during implementation and the stable release gate afterward. A scenario is not complete until its visible provider state, visible Paperclip state, and durable Activity/Conversation records all agree.

The required setup path in this runbook is deliberately the path the current branch can execute. Optional provisioning paths become blocking only after they ship:

| Provider        | Required executable setup                                                                                                | Non-shipped convenience                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Slack           | Customer-owned Slack app created from Paperclip's manifest; Bot User OAuth Token and Signing Secret entered once         | Managed **Add to Slack** OAuth installation    |
| GitHub          | Customer-owned GitHub App; Paperclip-generated webhook secret copied to GitHub, then App ID and private key entered once | GitHub App Manifest create-and-return exchange |
| Discord         | Customer-owned Discord bot; bot token, Application ID, and Server ID entered once; direct Gateway transport              | None                                           |
| Microsoft Teams | Customer-owned single-tenant Entra app, Azure Bot, and Teams app; client ID, tenant ID, and client secret entered once   | None                                           |
| Telegram        | BotFather bot token entered once                                                                                         | None                                           |

Customer-owned credentials are the complete first-release path for every provider. The two named managed exchanges are future conveniences, not shipped setup controls, release dependencies, or instructions the operator should search for in the current UI.

Direct verified webhooks are the required transport for Slack, GitHub, Teams, and Telegram. Discord uses a direct outbound Gateway connection and therefore does not require a public Paperclip URL. A private-instance relay, Slack Socket Mode, and Telegram polling are separate conditional deployment tests; none is a choice in the endpoint wizard.

A webhook provider is not deployment-qualified merely because it passed through a temporary tunnel. Live development may use an ephemeral HTTPS tunnel to find product defects, but stable release evidence requires a durable public ingress origin whose callback URLs survive process restarts and whose Paperclip secrets master key is preserved with the instance.

### Current setup gates — 2026-09-09 UTC

Slack, GitHub, Discord, and Telegram are configured and active in the isolated
live instance. The GitHub PEM, Discord bot installation/token, and replacement
Slack/Telegram credentials have been supplied. Webhook providers use the stable
Tailscale Funnel origin on port 8443; Discord uses its outbound Gateway.
The public proxy exposes verified webhook routes, not the private Board or files.

Maya E2E uses native Paperclip Runner with Codex `gpt-5.6-luna`; actual native
turn records confirm the model, with no Terra substitution. The
[current qualification ledger](./2026-09-08-chat-queue-and-webhook-repair.md)
records resumed model capacity, successful text replies on all four connected
providers, native files on Slack/Discord/Telegram, honest GitHub file fallbacks,
and the remaining defects. Earlier quota and GitHub/Discord login gates are
historical, not current blockers. Teams still requires an eligible Microsoft
365 work/school tenant and its admin-controlled setup.
The [reach audit](./2026-09-07-native-chat-reach-audit.md) records subsequent
model-independent live checks. These are scenario-specific evidence, not a
complete final-source qualification of every provider and feature.

Server 78 deploys implementation `ea528f44c` with qualified runner
`6279d39a…`; health and Discord Gateway reconnection passed. The current
candidate passes 846 integration, 367 helper/runtime and 31 deterministic
browser checks. It includes Slack rendered-stream bounds and partial-delivery
safety, durable Telegram private-draft Stop and automatic subscription repair,
alongside the earlier media, lossless text and Teams picture repairs.
The original Telegram subscription upgraded on attempt one at
`2026-09-09T09:18:29.075Z`; this is live provider-setting verification, not native
Stop-button UI proof. Command ID `1547131713472430131` was durably
registered on server 73; this is not live command-invocation proof. Latest real
Slack/Discord native PNG+TXT and GitHub private-file/pasted-text evidence is on
server 68, not this deployment. Server 78 conversation, command, modal and
media/Stop retests remain pending because the browser reports the Mac locked. Discord
login has been restored; do not treat an OS lock as a new provider login gate.
The [current handoff](./2026-09-08-open-qualification-followups.md) names exact
remaining journeys and protected historical recovery failures.

Current-head local npm-consumer qualification now includes all 17 freshly
compiled runtime packages, local-tarball installation with sibling registry
downloads denied, all 21 patched-file hashes and fenced compiled-server imports.
The freshly built packaged static UI passes 31/31 deterministic checks (2.0
minutes), with served HTML/service worker/main JS hashes matching its artifact.
Chat-control-plane API responses are mocked in that suite; this is not a
compiled chat-backend/provider round trip.
This uses the already qualified macOS runner, not a new native build. The
published CLI and CI-owned frozen-lockfile release workflow remain unqualified.
The
[CI-owned lockfile correction](./2026-09-08-chat-queue-and-webhook-repair.md#ci-owned-lockfile-correction)
distinguishes the successful local generated-copy install from the preserved
checked-in lockfile and the CI-generated artifact required by repository policy.
Do not manually change the lockfile or treat installed-module tests as clean
installation proof. The earlier failed frozen/offline check remains historical
evidence; it is not the whole current install workflow.

### Historical qualification snapshot — 2026-09-06

- **Evidence baseline:** committed revision `a534e07a6` pins the current evidence ledger. Its implementation parent `83018c688` contains the Discord log-redaction and setup-copy corrections. Parent merge `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88` passed the five-provider deterministic browser suite plus the focused merged-build live checks described below; `83018c688` then passed the 42-test Discord adapter/runtime subset, the 34-test Discord/OpenAPI/UI contract subset, and server/UI typechecks. Working-tree fixes made after this checkpoint remain deterministic evidence until the combined suite and relevant provider scenario are rerun.
- **Slack:** broad live evidence covers one-root/one-thread/one-task behavior, DM answer continuation, ordered follow-ups, exact final presentation, reaction add/remove, lifecycle edits/deletes, files, pause/resume, disabled-resource recovery, and one identity revocation/relink sequence. On the merged build, exact responses `SLACK-MERGED-C-0906` and `SLACK-MERGED-D-0906` passed on healthy ingress, while delayed-event recovery delivered `SLACK-MERGED-A-0906` and `SLACK-MERGED-B-0906` in order after tunnel rotation. Revocation created low-trust quarantined task `CHA-88` and failed closed without inheriting linked authority; after relinking and starting a fresh generation, `CHA-89` reached `done` with exact `SLACK-LINK-RESTORED-0906`. The retest also showed that Slack's Events API, Interactivity, and slash-command callback URLs can drift independently: updating only two left the command on an expired URL until it was repaired. It is not a complete S1–S7 pass; the rest of the governance matrix, injected ambiguous delivery, reinstall, and cleanup remain incomplete.
- **Telegram:** broad live evidence covers private chat, group/topic isolation, FIFO/bursts, commands, edits/reactions, documents, native confirmation continuation, and exact once-only final presentation. After rotating the expired test tunnel on the merged build, a fresh task returned exact `TELEGRAM-MERGED-A-0906` once and edited its working placeholder in place. A later code audit found that URL-changing reconnects could ask Telegram to drop queued updates; the working-tree fix preserves provider backlog on every reconnect and drops stale pre-Paperclip updates only during initial setup. That repair has focused deterministic coverage but has not yet been proved with a real queued-update outage. It is not a complete TG1–TG6 pass; identity governance, media boundaries, rate-limit recovery, token rotation, and cleanup remain incomplete.
- **GitHub:** current-source live setup remains blocked at GitHub's six-digit sudo-mode MFA prompt. Historical provider evidence is retained separately and is not current-source qualification.
- **Microsoft Teams:** live setup remains blocked before credentials by the need for a Microsoft 365 work/school tenant with Entra, Azure Bot, custom-app, and possibly tenant-admin authority. The signed-in personal Teams account is insufficient.
- **Discord:** the native Gateway implementation and deterministic/fresh-database tests exist, but the latest provider attempt remains blocked at the Eigenjoy account login/QR or passkey gate before application creation, installation in the authorized `Clawd` server, credential entry, or any DC1–DC7 event. See the [Discord result](./2026-09-06-discord-live-qualification-result.md).

The dated provider result documents are the evidence ledger. This snapshot is navigation, not proof and not a substitute for rerunning every blocking case on one final SHA.

The Telegram snapshot above predates the subsequent URL-changing reconnect
retest: the [Telegram result](./2026-09-05-telegram-live-qualification-result.md)
records real queued updates 75/76 preserved and processed once. The separate
[2026-09-07 recovery and Board-file audit](./2026-09-07-native-board-files-and-webhook-recovery.md)
records a stable-ingress reaction outage and explicit file sends, including
remaining Board feedback defects. Neither upgrades the whole provider matrix.

The account-less Cloudflare quick tunnels used during development are defect-finding infrastructure only. Their expiry caused real callback loss and configuration drift in the Slack and Telegram exercises. They do not qualify production ingress; release deployment requires a durable HTTPS origin, preserved instance key material, and provider callback health that is checked as one configuration set.

The four blocking outcomes are:

1. **Setup works:** a new chat connection can be created from `/apps` with the minimum provider-specific work.
2. **Reach is enforced:** provider installation or invitation only makes a resource available; Paperclip independently decides whether it is enabled.
3. **Identity and governance hold:** linked people use current Paperclip permissions, while allowed unlinked people remain inside the restricted external profile.
4. **Conversation integrity holds:** one external conversation maps to one task, follow-ups do not duplicate it, safe output publishes back, and all delivery state remains inspectable.

## 2. Execution model

### 2.1 What I drive in the browser

I use Codex's in-app browser with real signed-in sessions for:

- the Paperclip Connectors catalog, setup wizard, Settings, Access, Conversations, Activity, agent, and task screens;
- Slack, GitHub, Discord, Microsoft Teams, Telegram Web, and each provider's app-management or installation UI;
- every provider message, mention, reply, edit, action, file, command, and permission change in the run;
- identity-link confirmation as the mapped Paperclip user;
- screenshots and visible-state assertions at each evidence checkpoint.

The required v1 journeys stay in the browser. If Paperclip later ships a product-displayed one-time helper command, I may execute that command exactly as shown and return to the browser; I do not replace UI steps with private APIs.

### 2.2 Browser discipline

- Use accessible labels, headings, link targets, and stable test IDs rather than screen coordinates.
- Re-read the visible page after navigation, provider redirects, modal submission, or account switching before taking the next action.
- Use a separate authenticated browser profile/context for the installer, linked participant, and unlinked participant. Never switch identities in a way that leaves an ambiguous provider or Paperclip session.
- Never read secrets back from Paperclip, browser storage, cookies, or password managers. Secret entry is write-only and screenshots must show only masked values.
- Treat provider credential pages and BotFather conversations as secret-bearing for their entire lifetime, including loading and error states. Never request a full DOM snapshot, whole-page text, or screenshot on those surfaces: a loading error can resolve to a plaintext token before the diagnostic read executes. Inspect only explicitly allowlisted nonsecret labels, button states, and field types. Do not print field values, unrestricted parent text, or clipboard contents.
- A provider credential value goes directly into Paperclip's masked field through the operator's handoff. Do not extract it for diagnostic evidence. If a value reaches tool output, stop using it, clear any copied value, record the exposure without repeating the secret, and require revocation/replacement before qualification resumes. Deleting a local log is not revocation and does not erase prior tool output.
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

Replace `Slack` with `GitHub`, `Discord`, `Microsoft Teams`, or `Telegram` for the other cases. A provider run begins only after its deterministic case passes. The real-provider steps themselves run in the signed-in in-app browser; Playwright fixtures never stand in for provider installation, webhook proof, or Gateway proof.

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

Use an authorized Paperclip staging instance with real HTTPS webhook callbacks.
The Board may remain private; only verified webhook ingress needs public reach.
Name the company and run uniquely:

```text
Company: Chat Adapter E2E
Run ID: CHAT-E2E-YYYYMMDD-HHMM-<provider>
Agent: Maya E2E
```

`Maya E2E` is a dedicated test agent assigned to no production work. For live
qualification it must use the new Paperclip Runner with Codex, initially
`gpt-5.6-luna`. Verify actual admitted run records show `adapterType:
paperclip_runner`, `runtimeMode: native`, `driverKind: codex_app_server`, and
the explicit model; the agent's display name or saved configuration alone is
insufficient. Terra is an allowed fallback only when necessary; record the
reason and exact model, and do not present it as Luna evidence. Preserve the
qualified runner binary and record its SHA256 with the tested server version.

The following fixture vocabulary names behavior to exercise, not proof that a
real model is deterministic. For live cases, send clear requests for that
behavior and record the actual result, native run, and provider receipt:

| Incoming instruction | Public behavior                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ECHO <run-id>`      | Return exactly `ACK <run-id>`.                                                                                         |
| `LONG <run-id>`      | Emit safe queued/working progress and a final response long enough to exercise native streaming or post/edit fallback. |
| `FILE <run-id>`      | Read the attached `chat-e2e.txt`, report its marker, and publish `chat-e2e-result.txt`.                                |
| `FORM <run-id>`      | Request one short text value and one choice using the richest supported interaction, then echo the submitted values.   |
| `GOVERN <run-id>`    | Create a governed Paperclip approval and publish only the provider-safe approval status/link.                          |
| `FAIL <run-id>`      | Terminate predictably after the safe working state so failure publication and retry are observable.                    |

A deterministic suite may use a dedicated process adapter or simulated model
port, but its incoming turns must still traverse the normal chat delivery,
task, wakeup, run, and publication paths. Those tests do not satisfy the live
runner requirement. Inspect provider output for safe milestones and final
answers; raw reasoning, tool arguments and private traces remain internal even
when the native runner makes them available to Paperclip.

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
| Discord  | `#pc-e2e-enabled`                        | `#pc-e2e-disabled`                  |
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

### Provider lifecycle boundary

Reconnect always retains the endpoint's immutable provider bot identity. It revalidates or replaces credentials for that identity; it does not silently install an app, expand provider access, or switch bots. Telegram additionally refreshes its Paperclip webhook and command menu during reconnect. GitHub reconnect uses the already-verified App's JWT to restore its current Paperclip webhook URL, stored secret, JSON encoding, and TLS verification. It does not change event subscriptions, repository permissions, installations, or GitHub's **Webhooks · Active** toggle. A successful configuration response is not connectivity proof: historical signed-ping evidence is retained, while a fresh inbound conversation, follow-up, and agent final remain required before activation.

Removing a connection archives the Paperclip endpoint, stops its runtime, marks retained conversation history `endpoint_removed`, and retires endpoint-owned credentials. It is not a provider uninstall. Slack, GitHub, Discord, and Microsoft resources remain installed or registered until an operator removes them at the provider. Telegram is the one automated provider-cleanup exception: Paperclip durably removes the bot webhook and command menu before retiring the saved token, but the BotFather bot and its chat memberships still remain.

| Provider        | What still exists after **Remove connection**                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| Slack           | The Slack app installation and any channel memberships                                                      |
| GitHub          | The GitHub App registration, installations, repository grants, and webhook configuration                    |
| Discord         | The Discord application and the bot's server installation                                                   |
| Microsoft Teams | The Entra app registration, Azure Bot, custom Teams app, and team/chat installations                        |
| Telegram        | The BotFather bot and chat memberships; only Paperclip's webhook and command menu are removed automatically |

### 3.5 Shared preflight

Before starting a provider run:

1. Confirm Paperclip health and sign in as Dana E2E.
2. In instance **Experimental** settings, confirm **Chat connectors** is enabled
   for this isolated qualification instance. Run C0 on a disposable instance
   before enabling it; do not toggle an unrelated instance. Confirm Maya is
   active, uses the native runner/model above, and can complete an ordinary
   Paperclip task through that runner before sending a provider test message.
3. Confirm the provider installer, Ari, and Jules browser sessions are signed into the intended sandbox accounts.
4. Confirm the provider test resources contain no production data and that prior run messages/issues can be distinguished by run ID.
5. Confirm the verified webhook ingress is publicly reachable when qualifying Slack, GitHub, Teams, or Telegram. For a private board, set `PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL` to the HTTPS webhook-only origin and keep `PAPERCLIP_PUBLIC_URL` at the real board origin. Public `POST /api/chat-webhooks/*` may be forwarded; the private board/API must not be. Verify external task links use the board, never the webhook-only host; local/private links should be omitted with neutral instructions. For Discord, confirm outbound HTTPS/WebSocket access to Discord instead. Relay qualification is a separate deployment run described in section 10.
6. For first-time setup, use a new dedicated bot identity and disposable endpoint.
   For follow-up qualification, reuse the intended existing endpoint and record
   its current state. Never remove a live qualification endpoint simply to
   restart this checklist, or erase unresolved delivery/recovery evidence.
   Explicit removal/reinstall cases use disposable fixtures and verify retained
   history. Paperclip removal does not uninstall provider resources, except
   that Telegram webhook/menu cleanup is automatic.
7. Start browser recording/screenshots before `/apps`; record the Paperclip SHA and current time.

### 3.6 Human login and credential handoffs

I drive every unblocked browser step myself. I pause and ask the user only at these boundaries:

| Provider        | Human action that may be required                                                                                                            | What I do immediately afterward                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Slack           | Sign in to the sandbox workspace, approve installation, or paste the customer-owned bot token/signing secret into Paperclip's masked fields. | Resume at the Slack consent result, verify the requested scopes, invite the bot, and execute S1–S7. |
| GitHub          | Sign in to the sandbox organization, approve App creation/installation, or upload a newly generated private key for the manual path.         | Verify the repository grant and permissions, then execute G1–G7.                                    |
| Discord         | Sign in to the developer portal, complete CAPTCHA, approve the server install, or paste the bot token into Paperclip's masked field.         | Verify the bot identity, Message Content intent, exact install permissions, and execute DC1–DC7.    |
| Microsoft Teams | Sign in to the test tenant, satisfy tenant-admin consent, or enter the client secret in Paperclip's masked field.                            | Verify the created bot/app identity and install target, then execute T1–T7.                         |
| Telegram        | Sign in to Telegram Web or copy the BotFather token into Paperclip's masked field.                                                           | Verify the bot identity with the provider, then execute TG1–TG6.                                    |

CAPTCHA, passkey, MFA, organization approval, tenant approval, and secret entry remain user-controlled. I never ask the user to send a credential in chat, and I never copy a secret into test evidence. A pause records the exact browser page and the single action needed so the run can resume without repeating completed setup.

### 3.7 Execution order and result rule

Run the providers in this order unless a provider outage makes another order more efficient: Slack, GitHub, Discord, Microsoft Teams, then Telegram. For each provider:

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

### C0 — Experimental visibility without breaking existing tools

1. On a disposable instance with **Chat connectors** off, open Connectors.
   Chat-only setup must be hidden. GitHub's production tool connector must
   remain available and go directly to tool setup, without a chat/tool chooser.
2. Follow a saved chat setup/detail URL and the agent Channels URL. They must
   return to the supported catalog/agent view without exposing chat controls.
3. Turn **Chat connectors** on in instance Experimental settings. The chat
   catalog entries, chat routes and agent Channels view must now be available.
4. If testing an already connected disposable endpoint, turn the setting off
   and verify it only hides Board surfaces: it must not stop the connection or
   revoke credentials. Restore the setting before continuing chat UI tests.

**Pass:** chat UI is opt-in; production tool connections remain usable, and a
visibility setting is never presented as runtime pause or removal.

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
4. Open the provider-specific link (**Open Slack**, **Open GitHub**, **Open Discord**, **Open Microsoft Teams**, or **Open Telegram**) and **Open task** from the same row.
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
7. From the canonical task-identifier URL, send a Board update with a selected file and image. Confirm the new comment and attachment bindings appear without reloading. For a delayed send, keep the composer mounted: it must track the entire batch, not declare success after the text alone publishes.
8. Reload or navigate away and back while that send is pending. The exact draft and delivery identity must remain locked; status checks must not send another provider message. **Files in this send** must keep the selected filenames visible and checked, even after they bind to the Board comment; unrelated unchecked files must not replace this receipt. After completion or explicit cancellation, a new draft must not offer those bound files again. If the original response was lost, **Retry safely** must explicitly reuse the original text, selected files, and request identity. A failed or unconfirmed part keeps the draft until Activity resolves it; no automatic replay is allowed.

**Pass:** only safe milestones/final output and explicit board publication leave Paperclip. No internal material is exposed.

### C6 — Files, interactions, concurrency, edits, and failure

1. Upload `chat-e2e.txt` containing only `FILE-MARKER <run-id>` and send `FILE <run-id>`.
2. Verify Paperclip stores a bounded normal attachment, Maya reads the marker, and the result file is reachable through a provider-supported upload or an authenticated Paperclip task link. Never expose the private Board or an asset through the public webhook origin.
3. Send `FORM <run-id>` and complete the richest provider-supported action/form. Verify the submitted values reach the existing task exactly once.
4. Send `ECHO <run-id>-Q1` and `ECHO <run-id>-Q2` rapidly in the same conversation.
5. Verify default queue order in the task and publications.
6. Edit one human provider message, then delete another test message.
7. Verify Paperclip appends a correction/tombstone rather than rewriting audit history.
8. Where the provider emits reaction callbacks, add and then remove a reaction on a linked test message, then repeat the same add/remove cycle. Verify Activity records all four distinct occurrences, while a duplicate delivery of the same provider event is deduplicated. Keep Activity open to check automatic refresh. In DMs, also react to a message from a completed task after a newer generation starts; the event must remain on the original task and obey current destination/access restrictions. The task must receive no new comment, wakeup, approval, or governed action.
9. Send `FAIL <run-id>`, verify the safe failed state, then use the authorized retry action from Activity.
10. On a disposable task, explicitly send a 100,000-character Board comment
    with distinct beginning, middle and final markers. Repeat from an existing
    comment. Verify complete content in ordered provider messages or the
    provider's documented native Markdown-file transport. Nothing may silently
    truncate at 40,000 characters. Include Unicode, escaped punctuation and a
    long code block; oversized indivisible rich blocks may use visible Markdown
    source, but all source text must remain available.
11. Use deterministic fault injection for an unknown receipt in a middle text
    part. Later parts must wait, already confirmed parts must not resend after
    restart, and Activity must require explicit resolution of the uncertain
    part. These protocol checks do not replace inspecting the live rendering.

**Pass:** every supported native feature is used. Questions and confirmations follow the adapter's documented text/link/private fallback when native controls are unavailable; richer governance interactions remain Paperclip-only. Inputs apply once, queued turns retain order, edits/deletes and reactions remain auditable, reactions are never interpreted as authority, and retry does not duplicate task state or provider output.

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
- The prepared customer-owned App Manifest path is the required baseline and is qualified for every stable release and after any manifest/scope change. Managed **Add to Slack** is optional when available and is not a prerequisite.

### S1 — Required customer-owned Slack App setup

Run this for every stable release, after any Slack manifest/scopes/events change, and for self-hosted release candidates:

1. In Paperclip, perform C1 and select Slack.
2. On **Connect a Slack app**, copy the generated manifest and open Slack app settings.
3. In Slack, choose **Create New App** → **From an app manifest**, select only the sandbox workspace, paste the manifest, and inspect its bot scopes before clicking **Create**. Abort if Slack shows scopes beyond the versioned Paperclip manifest.

   The generated manifest declares `features.agent_view`, requests `assistant:write`, and subscribes to `agent_session_stopped`. This supplies native working status and Stop where Slack has enabled agent sessions. An existing app using legacy `assistant_view` needs an explicit operator migration: Slack documents that switching it to `agent_view` cannot be reversed. Reinstall after a scope change. See [Slack's manifest contract](https://docs.slack.dev/reference/app-manifest/) and [agent sessions](https://docs.slack.dev/ai/agent-sessions/).

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
- completed, approved output has no simulated generation delay. Qualify both
  ordinary paragraphs and cached `@name` expansion; each actual native payload
  must fit provider limits and delivery must await the final receipt. This
  does not establish model latency or explain delays before webhook ingress;
- `FORM` uses Block Kit buttons/selects and a modal for the text field; modal submission applies once;
- files ingest and publish without exposing Paperclip credentials;
- an unauthorized action uses an ephemeral safe denial; any generic text fallback contains no private task/account details and does not open an unsolicited DM;
- In the bot DM, the registered agent command with `status` returns the active task state; `new` advances the DM to a fresh task generation and `close` closes the active one. In a channel, Slack does not include a thread timestamp in slash-command payloads, so these controls return private guidance to use the task link in the native thread rather than guessing among channel tasks;
- the standard `eyes` receipt reaction is used without requiring a custom workspace emoji; retry/failure of that reaction does not re-admit the task or duplicate its message;
- after a turn's final output is published, its `eyes` reaction clears. Use
  deterministic fault injection for final-before-add and delayed add/removal:
  an old completion must not remove a newer message's receipt. The reaction
  acknowledges one admitted message; a same-source retry does not create a
  new receipt, and native status conveys its working state. A stalled
  acknowledgement must settle within its
  bounded transport budget and release its credential lease before a ready
  reply proceeds; it must not hold the reply behind the ordinary message
  timeout. Provider rejection or malformed replies must not count as success;
- native session status tracks working, waiting for input, final output, and closed conversations. A status-only rate limit retries independently, without replaying a provider reply. A working run exceeding 30 minutes refreshes status before Slack's one-hour timeout;
- as a linked non-viewer, click native **Stop** during a long response. Verify the exact task/run is stopped, the visible confirmation says it stopped at your request, and working status clears. Repeat the same event, deliver it late after a new turn, and try as an unlinked or revoked identity: no later/unrelated run may be cancelled. The Paperclip Activity tab records the result;
- a duplicated Slack retry is deduplicated and visible in Activity.

### S6 — Slack DMs and recovery

1. Toggle **Allow direct messages** off and message Maya from Ari. Verify no task or agent wakeup.
2. Turn it on. Send `ECHO <run-id>-DM1`, then a follow-up; confirm one open DM task.
3. Complete that task in Paperclip and send `ECHO <run-id>-DM2`; confirm a new task.
4. Pause the connection; address Maya in an enabled channel; verify no new run/publication.
5. Resume and send a new marker; verify recovery.
6. Run the registered slash command with a task body. Verify Slack gets exactly one `Starting a task…` root, the Conversations row uses that message as its native thread boundary, and every Paperclip response remains under that root. In a DM, verify the next `status` and `close` commands target that same task rather than creating or controlling an unrelated base-DM task.
7. During deterministic fault injection, simulate a connection loss after Slack may have accepted the starter root. Verify Activity labels the task start unconfirmed and does not replay it automatically. After checking Slack, exercise both explicit paths: **Retry anyway** warns that it can duplicate both the starter and task, while **Cancel task start** leaves no Paperclip task. Verify a concurrent double-click produces at most one retry and each operator decision has an activity-log audit row.
8. For the scheduled recovery qualification, revoke or uninstall only the disposable Slack app, verify Activity shows the contextual reconnect/reinstall action, then repair it.

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
2. On **Create or connect a GitHub App**, copy the Paperclip webhook URL and click **Open new GitHub App form**.
3. In the sandbox organization, open **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
4. In Paperclip, click **Generate webhook secret**. Copy the one-time value immediately, then enter the Paperclip webhook URL and generated secret in GitHub with the webhook active and SSL verification enabled. Paperclip must show only the configured state plus **Waiting for GitHub to deliver its signed webhook ping…** after refresh. If **Regenerate webhook secret** is used, update GitHub before expecting another webhook to verify.
5. Under repository permissions, set **Metadata: read**, **Issues: read and write**, and **Pull requests: read and write**. Leave Contents, Actions, Administration, and organization permissions at **No access**.
6. Subscribe only to the selectable **Issue comment** and **Pull request review comment** events. GitHub sends **Installation** and **Installation repositories** to every GitHub App automatically, so they do not appear as subscription controls. Save the App.
7. Return to Paperclip and wait for **GitHub has verified this webhook.** A correctly signed GitHub `ping` must set this state; an unsigned or incorrectly signed `ping` must not. **Connect and verify** remains disabled until this proof arrives.
8. Copy the numeric **App ID** into Paperclip. Under **Private keys**, generate and retain the downloaded PEM, then use **Choose .pem file** in Paperclip (or paste the multiline key into its masked field). Confirm the loaded state without revealing, recording, or screenshotting the key. Empty, unreadable, or over-64-KiB files should show a safe inline error; imports must preserve line breaks and never upload a file separately from the credential setup request.
9. In GitHub, click **Install App**, select the sandbox organization, choose **Only select repositories**, and grant the two test repositories.
10. Return to Paperclip and click **Connect and verify**. Paperclip must verify the App identity without displaying the secret or private key again.
11. In `paperclip-chat-e2e-enabled`, open a new issue titled `<run-id> setup`, comment `@<verified-bot-login> ECHO <run-id>-SETUP`, then add an unmentioned follow-up comment.
12. Return to Paperclip, run the setup test once, and verify Settings opens with the tested repository enabled and the second installation repository disabled.

**Pass:** Paperclip generates and stores the webhook secret, returns it only once for copying to GitHub, requires a correctly signed setup ping before credential verification, and asks the operator to enter only App ID and private key; least-privilege repository permissions are visible in GitHub; the real issue conversation completes setup; no PAT is used.

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
- output within the native size bound uses one GFM comment with coarse updates;
  larger final output uses complete, ordered, durably tracked comments rather
  than truncation or token-by-token comment noise;
- provider edits preserve a stable message link and final content;
- rich actions/forms fall back to explanatory text plus an authenticated Paperclip link;
- public inbound GitHub uploads referenced in the exact admitted comment are ingested from canonical `github.com/user-attachments/assets/…` or `files/…` URLs. Test a PNG and text file in issue, PR, and inline-review comments, then verify exact bytes on the Paperclip task and native agent inspection. Arbitrary external links are not fetched;
- attachment byte downloads use no App token, user token, or browser cookie. For new private images, the existing installation App may read the exact admitted comment's canonical rendered HTML from `api.github.com`; only an unchanged source/body and unique same-asset signed image mapping permit a credential-free download. Qualify this separately with a new private image. Generic private files or unsupported renderings remain unavailable: verify a 403/404 or login/error response produces a current-input omission, no stored file, and no substitution of an older attachment;
- restart before deferred attachment processing and verify the stable comment-bound descriptor recovers once. Signed CDN redirect URLs remain transient; ordinary delivery JSON contains only the original query-free locator. Downloads retain deployment MIME/byte limits, public-address/redirect allowlists, a 20-second per-file deadline and shared 60-second batch deadline. After batch expiry, remaining files produce explicit current-input omissions without further network requests. More than 20 file references produce an attachment-limit omission that survives restart rather than silently claiming all files were imported;
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

Capture the App permission screen, selected repositories, issue/PR/review conversations, reaction/edit behavior, public inbound attachment hashes, private-file omission, fallback link, Conversations rows, duplicate delivery, and unavailable/recovered state. Close test issues/PRs, delete the disposable GitHub App, revoke identity links, and remove the Paperclip connection. The GitHub App does not upload output files; public inbound fixtures are user-uploaded and must be included in the authorized cleanup scope. Never delete a repository unless the authorization envelope explicitly names it as disposable.

GitHub documents [anonymous access for public uploads and repository-gated private uploads](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files). The narrow private-image canonical-resolution path and its unqualified boundaries are detailed in [GitHub private attachment authority](2026-09-08-github-private-attachment-authority.md); this is not general private-file or direct App-token download support. The [GitHub CLI upload implementation](https://github.com/cli/cli/blob/trunk/internal/attachments/client.go) permits OAuth/PAT/fine-grained PAT credentials, not App installation tokens; Paperclip therefore retains its truthful private-task outbound fallback without broadening repository permissions.

## 7. Microsoft Teams live browser runbook

### Teams prerequisites

- Microsoft Teams personal/free accounts at `teams.live.com` cannot complete this setup. Use a Microsoft 365 work or school organization with Entra, Azure Bot, and custom Teams app access.
- The shipped setup is qualified only for Microsoft 365 commercial cloud tenants. GCC, GCC High, DoD, and Microsoft 365 operated by 21Vianet are not supported yet; do not infer sovereign-cloud support from Microsoft-owned service URLs accepted during signed activity handling.
- Dedicated Microsoft 365 developer tenant with Dana as permitted app installer and Ari/Jules as members.
- Team `Paperclip Chat E2E` with the Enabled and Disabled channels.
- Permission to create an Entra application and Azure Bot. No provisioning helper is shipped or required.
- Tenant policy that permits custom-app upload/install, or a test administrator available to approve it.

### T1 — Required customer-owned Microsoft setup

Run before stable release and after identity, Teams manifest, or permission changes:

1. In Paperclip, perform C1 and select Microsoft Teams. Keep **Connect Maya to Microsoft Teams** open and copy the displayed Paperclip messaging endpoint. Follow the on-screen **Microsoft portal field map** and use **Copy manifest settings** as the Paperclip-specific manifest reference.
   Confirm the setup screen explicitly says that a Microsoft 365 work or school organization is required, that `teams.live.com` personal/free accounts are unsupported, and that this release is commercial-cloud-only.
2. In the sandbox tenant's Microsoft Entra admin center, create a **single-tenant** app registration. Record its Application (client) ID and Directory (tenant) ID, create one client secret, and keep the secret value available only for immediate entry.
3. In Azure, create an **Azure Bot** using that existing Application ID and the single-tenant identity type. Set its messaging endpoint to Paperclip's displayed URL and enable its Microsoft Teams channel.
4. In Teams Developer Portal, select **Apps > New app**. Under **Configure > App features > Bot**, add the existing bot using the same Application ID and enable Personal, Team, and Group chat scopes plus file support. Under **Configure > Permissions**, add the RSC application permissions in the next step. Complete the required app metadata and icons; Paperclip's copied block is a field reference, not a complete app package.
5. Add the resource-specific application permissions required by the shipped manifest: `ChannelMessage.Read.Group` and `ChatMessage.Read.Chat`. These RSC grants let the installed app receive every message in that team or group chat without an `@mention`; explain that provider access in the app description shown to installers. Paperclip still retains and acts only on messages admitted by its reach/access rules. Do not grant tenant-wide directory/history permissions.
   Keep the copied `webApplicationInfo.id` equal to the same Entra Application ID so Teams can bind those RSC permissions to the app, and keep its nonempty RSC-only `resource` value. Paperclip does not use Teams single sign-on in this release; the resource is only an RSC placeholder, so this connection does not require registering an Entra Application ID URI or adding delegated Microsoft Graph permissions. One team install covers that team's standard channels. Private and shared channels require a separate installation and are not supported by this release.
6. Download the app package, then in Teams use **Apps > Manage your apps > Upload an app > Upload a custom app**, or publish it to the sandbox organization according to tenant policy.
7. Return to Paperclip. Enter only Application/Client ID, Directory/Tenant ID, and the client-secret value, then click **Verify Microsoft credentials**. Confirm the secret remains masked and is not shown again.
8. In Teams, open the app installation surface, click **Add**, and install it into `Paperclip Chat E2E` and personal scope when prompted.
9. In the Enabled channel, create a new post containing `@Maya ECHO <run-id>-SETUP`, then reply beneath it without another mention.
10. Return to Paperclip, run the setup test once, and verify Settings opens with the tested channel enabled.

**Pass:** only the three portable identity values are requested; the messaging endpoint and Teams app are correctly wired; the real post/reply conversation completes setup; commercial-cloud-only scope is explicit and no delivery-mode or cloud-strategy choice appears.

### T2 — Reserved future setup slot

No Microsoft provisioning helper is shipped or required. Record T2 as **NOT SHIPPED — NON-BLOCKING** and execute the complete customer-owned path in T1. If a guided flow is implemented later, this section must be replaced with its actual reviewed resource, consent, credential, and cleanup contract before the flow can enter release qualification.

### T3 — Team/channel reach

1. Verify installation at the provider is scoped to the test team.
2. Deliver at least one installation or message lifecycle event from each test channel before expecting it in Paperclip. For an untouched channel, send a benign unmentioned discovery message; Paperclip does not fetch a Teams channel inventory proactively.
3. In Paperclip Settings, confirm both discovered team channels are available but only Enabled is on.
4. Run C2 in the Disabled channel.
5. Install Maya into a second disposable test team, trigger one lifecycle/message event in each channel, refresh, and verify the discovered channels appear disabled.
6. Remove the app from that second team and verify unavailable state.

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

- DM, channel, and group output use bounded post/edit behavior; the current durable webhook pipeline advertises no native Teams streaming;
- `FORM` uses an Adaptive Card and task module where supported, with server-side reauthorization on submit;
- personal-chat Bot Framework file-download attachments are ingested only when
  the adapter supplies a scoped bot or anonymous download contract and the file
  passes Paperclip's allowed-content policy and configured size ceiling (10 MB
  by default). Channel/group inline pictures require an exact authenticated
  source-activity binding and a bounded Bot Connector download; arbitrary files
  remain provider references without a separate Microsoft Graph grant;
- outbound personal-chat files require an exact admitted recipient and native
  file consent. No file upload occurs before acceptance. Channel/group picture
  messages use bounded original PNG/JPEG/static-GIF bytes (at most 1,000,000
  bytes and 1024 × 1024). Other channel/group files, unsupported images, or a
  personal conversation without sufficient recipient proof retain the truthful
  private-task/task-link fallback. A consent-card receipt is not a delivered file;
- denials use targeted activity when supported, otherwise DM or concise text plus a Paperclip link;
- tenant ID plus Entra object ID, not display name/email, determines identity;
- edit a source message, soft-delete it, restore it, then edit it again; verify
  Paperclip records exactly one correction, tombstone, restoration, and later
  correction without waking an extra agent run;
- app removal, consent revocation, or invalid bot identity appears in Activity with the correct repair action.

For the personal-chat file journey, use a new admitted task and a small image
plus a text file whose marker/bytes can be checked:

1. Send both files from the task's **Send to channel** composer. The text may
   arrive first; each file must show a native consent card and the Board must
   remain waiting, not declare the entire send delivered.
2. Reload the Board. Confirm both filenames and the original send remain locked
   without another comment, consent card or upload.
3. Accept one file in Teams and decline the other. Open the accepted native file
   and check its bytes. Verify the Board reports one delivered file and one
   declined file, with explicit dismissal only once the whole batch settles.
4. On a separate send, leave consent unanswered until expiry. Check the expired
   outcome and no late automatic upload. Repeating an already accepted callback
   must not send another file or wake the agent.
5. Remove the recipient's Paperclip authority between the card and acceptance.
   Verify no upload. Restore access only for a new qualifying attempt; do not
   rewrite the original evidence or claim that revocation was ignored.
6. Use the deterministic fault-injection suite, not provider account disruption,
   for lost acknowledgements and restart races. Confirm Activity requires the
   current file stage/version; retrying an uncertain final file message must
   never repeat a confirmed byte upload. Cancel is not remote deletion or proof
   that the provider received nothing.

For channel/group pictures, repeat in both surfaces:

1. Send a small PNG from Teams. Verify its exact bytes belong to the current
   Paperclip input, and Maya can inspect that picture rather than an earlier
   task attachment. Repeat through deferred intake/restart using the local
   fault-injection suite; revocation or a pending source edit/delete must
   prevent attachment registration. The image batch shares a ten-second
   token/download budget: a stalled credential must not start another image
   request after expiry. DB/storage commit work is not cancelled or declared
   failed merely because that download budget expired.
2. Ask Maya for a picture and explicitly send a Board picture. Inspect both
   native images in Teams and their saved task attachments. Neither should
   require a personal-file consent card or publicly accessible asset URL.
3. Send an oversized image and a text file. Check that each remains available
   on its exact task with a truthful fallback, not a claim that Teams received
   an image. A lost or empty provider receipt must remain unconfirmed without
   automatic resend.

The local mocked suite covers protocol races; only the actual Teams consent,
usable file, rendered picture and Board journeys establish live qualification.

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
2. If a membership callback has not discovered a group yet, send `/task@MayaBot DISCOVER <run-id>` in it so Telegram delivers a provider-native command to Paperclip.
3. Open Paperclip Settings. Verify both groups are available and Disabled remains off.
4. Run C2 in the Disabled group.
5. In Enabled, create/open forum topic `Run <run-id>` and enable that topic in Settings if topics are listed separately.
6. Remove Maya from Disabled and verify unavailable state.

If Telegram upgrades an enabled basic group to a supergroup while Topics are enabled, verify Paperclip marks the old chat unavailable and disabled, carries the explicit Paperclip enablement to the replacement supergroup, preserves its human title, and keeps any existing topic-to-task bindings on the same topic IDs.

**Pass:** Telegram membership/discovery is the provider ceiling. Paperclip enables the narrower set of groups/topics.

### TG3 — DM, ordinary group, and forum boundaries

1. In DM, send `ECHO <run-id>-DM1` and two follow-ups; verify one open task.
2. Send `/new`, then `ECHO <run-id>-DM2`; verify a new task. Send `/close`, then another message; verify the next task generation.
3. In Enabled ordinary group, send `/task@MayaBot ECHO <run-id>-GROUP`. Telegram privacy mode does not deliver ordinary `@MayaBot` mentions.
4. Continue once by replying directly to Maya and once with another `/task@MayaBot <follow-up>` command.
5. Send an unrelated group message; under privacy mode, verify it is not processed.
6. In the forum topic, start with `/task@MayaBot <request>`, add follow-ups by direct reply or another `/task` command, then run C4.

**Pass:** DM/ordinary group uses an explicit active-task generation; forum `message_thread_id` has one stable topic task; privacy-mode unrelated traffic creates nothing.

### TG4 — Telegram capabilities

Run C3, C5, and C6, then verify specifically:

- Telegram shows typing/reaction acknowledgement where allowed;
- long output uses throttled post/edit, and private draft preview only when explicitly supported by the adapter/account. Already-complete approved text has no artificial generation pause; provider pacing and awaited final receipts still apply;
- `FORM` uses inline keyboard buttons; fields that require a modal fall back to a Paperclip link or sequential prompts;
- `/task <request>`, `/new`, `/status`, and `/close` are parsed as the documented small command vocabulary, and Paperclip registers that menu automatically;
- image/document/media ingestion is bounded and type checked;
- send a rich quotation beside ordinary paragraphs, then rich documents mixed
  with photos and text. Verify complete ordered content, quotation credit,
  original file bytes and the same task/topic after deferred intake/restart.
  Edit or revoke the source during download and confirm no stale file is
  registered. Unknown/malformed/deep rich blocks must produce a truthful
  omission, never silently drop content or expose draft-only thinking/control
  payloads. Use verified-webhook deterministic fixtures for provider shapes
  that the installed client cannot compose; label those as simulated;
- send voice, audio, video, animation and a Live Photo. Verify current-input
  originals on the same task and topic, including both Live Photo parts.
  Use signed-envelope deterministic fixtures when Telegram omits optional
  MIME metadata; only exact source-bound supported media may be identified
  from bounded bytes. Ordinary unknown documents and malformed media must
  not bypass the content policy. Repeat deferred intake after restart and
  revoke or edit the source while a download is in flight;
- reject a file above the configured attachment ceiling. Recovery guidance
  must name that deployment's actual limit, not a larger hard-coded size;
- an authenticated rejected inline-button action in a group uses Telegram's
  recipient-only native callback response. Another participant must not see
  it; missing/ambiguous receipts must not fall back to a group message or
  unsolicited DM. Eligible private-chat callbacks retain their exact-actor DM
  denial. Duplicate, delayed, restarted, revoked or cross-recipient actions
  must not extend the original response deadline or send to another user;
  API acceptance alone does not prove an online client displayed the notice.
  Private commands remain disabled until their separate input-identity and
  receipt contract is qualified;
- callback data contains only an opaque short key and every click reauthorizes the Telegram principal;
- flood-control retry honors provider timing and produces one final message.

### TG4a — Exact private-draft Stop

For an existing connection, first verify automatic subscription maintenance
confirms the current bot, credential generation and already-managed callback
URL. No manual reconnect should be needed. Until that durable confirmation,
private chat must still deliver ordinary complete replies without a Stop
control. An accepted update alone is insufficient: an independent provider
read must contain the requested subscription. Unsafe settings or failed
verification must retain the ordinary-reply fallback. Do not change another
webhook, drop pending updates or broaden unrelated explicit subscriptions.

1. In a private bot chat, request an answer long enough to observe the native
   draft. Click Telegram's **Stop** while that draft is visible. Verify the
   preview stops and no permanent final message replaces that exact stopped
   draft. If the client finishes too quickly to click, record that race as
   unobserved; do not count a simulated Stop as live UI proof.
2. Open the linked Paperclip task. The saved answer and task/run history remain
   intact; Activity identifies the exact publication as cancelled because its
   draft presentation was stopped. Stop is not a task/run cancellation command
   and must not claim that other parts of an output batch were stopped.
3. Send a follow-up. Verify its new draft/final completes normally and a late
   duplicate Stop from the earlier draft cannot suppress it. A Stop received
   after final-send begins must not claim to undo that already in-flight send.
4. Use verified-webhook deterministic fixtures for first-request/Stop overlap,
   callback database failure and retry, process restart, wrong chat/topic/bot,
   source edits, credential revocation, and deleted-endpoint/bot rebind. Require
   no draft-ID reuse, no false published receipt, no automatic replay of an
   uncertain final, and no cancellation of the current model run. Label this
   supporting evidence as simulated; native client button placement and timing
   still require the real walkthrough.

### TG5 — Token/webhook recovery

Run only against a disposable bot or scheduled credential-rotation fixture:

1. Rotate/revoke the bot token in BotFather.
2. Verify Activity shows an invalid-token repair action and no secret value.
3. Enter the replacement token through reconnect.
4. Send a new marker and verify the existing endpoint recovers without changing historical task links.
5. Verify direct verified webhook health. Polling is qualified only in the separate instance-admin developer-mode run, never as an endpoint choice.

### TG6 — Telegram evidence and cleanup

Capture the masked token step, DM setup proof, group disabled/enabled states, forum topic, inline keyboard, file/media behavior, active-task transitions, Conversations rows, flood-control/recovery evidence, and Activity state. Remove the bot from disposable groups, delete the disposable BotFather bot when authorized, revoke identity links, and remove the Paperclip connection. Never include the token in screenshots or results.

## 9. Discord live browser runbook

### Discord prerequisites

- A dedicated Discord application owned by the test account and a disposable bot token.
- Permission to install the bot in the sandbox server and manage its channel-specific permissions.
- Two ordinary text channels: `#pc-e2e-enabled` and `#pc-e2e-disabled`.
- Developer Mode enabled long enough to copy the sandbox Server ID. Do not use a production community server.

### DC1 — Required customer-owned Discord bot setup

1. In Paperclip, perform C1 and select Discord.
2. Open Discord Developer Portal and create one application dedicated to `Maya E2E`. Copy its Application ID.
3. On the Bot page, enable the **Message Content Intent**, reset the token if necessary, and paste the token only into Paperclip's masked field.
4. Enter the sandbox Server ID in Paperclip. Once the Application ID and Server ID are present, inspect Paperclip's generated **Install bot in this server** link before opening it.
5. Confirm the authorization URL requests only the `bot` OAuth scope and permission integer `309237763136`: View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Add Reactions, Embed Links, and Attach Files. Do not add Administrator or Manage Server.
6. Install the bot only in the sandbox server. If Discord requests a CAPTCHA, passkey, MFA, or server-owner approval, pause on that exact page for the user.
7. Click **Connect Discord bot**. Paperclip must verify that the token belongs to the Application ID, Message Content is enabled, the bot is installed in the stated server, and at least one text channel grants the complete feature set.
8. Enable only `#pc-e2e-enabled` in Access. In that channel, send a new root message containing `@Maya E2E ECHO <run-id>-SETUP`, then reply once inside the thread Paperclip creates.
9. Return to Paperclip, complete the message test, and verify Settings opens for the same immutable agent and Discord server.

**Pass:** setup asks for only bot token, Application ID, and Server ID; no public webhook URL, interactions public key, slash-command configuration, delivery-mode choice, or provider-capability toggle appears; one real mention/reply completes setup.

### DC2 — Channel reach and provider ceiling

1. Confirm the bot can see both sandbox text channels, but only Enabled is on in Paperclip.
2. Run C2 in Disabled and verify no task, reaction acknowledgement, or agent output.
3. Deny **Create Public Threads** or **Send Messages in Threads** for the bot in Disabled, refresh Access, and verify the channel is unavailable rather than silently degraded.
4. Restore the exact permission, refresh, and verify the channel returns available but disabled.
5. Remove the bot from the server only during the disposable recovery case; verify Paperclip cannot treat its own allowlist as a substitute for provider membership.

**Pass:** Discord membership and effective channel permissions are the provider ceiling. Paperclip's per-channel allowlist is an independent, narrower gate.

### DC3 — Thread boundary, ordering, and duplicate safety

1. In Enabled, send one root mention with `ECHO <run-id>-ROOT`.
2. Verify Paperclip creates exactly one Discord public thread named from the request text with the bot mention removed and creates exactly one Paperclip task.
3. Immediately send two ordered replies inside that thread while the first agent turn is still running. Verify the queue preserves arrival order and every reply maps to the original task.
4. Send an unrelated root message without a bot mention. Verify it creates no thread, task, or acknowledgement.
5. Mention Maya in a second root message. Verify a second Discord thread and second Paperclip task are created, with no cross-publication.
6. Inject a duplicate `MESSAGE_CREATE` event and a crash after provisional receipt persistence. Verify recovery idempotently creates or reuses the provider thread, treats Discord error `160004` (a thread already exists for the root message) as reconciliation rather than failure, deduplicates the delivery, and creates only one task.
7. Hold the Gateway callback during endpoint reconnect/shutdown. Verify the old runtime is fenced and the replacement runtime does not produce a second task or response.

Current implementation note: Paperclip now completes endpoint, channel, principal, and root-message preflight before any provider-thread side effect. A denied root must create one payload-redacted filtered audit row and no Discord thread, task, reaction, reply, or run. An allowed root must durably persist its provisional receipt before the provider POST. Missing root messages filter explicitly; ambiguous transport/authentication failures remain retryable instead of being mistaken for a completed binding. These paths have deterministic and fresh-database evidence but still require DC2/DC3 provider proof.

**Pass:** one root mention equals one Discord thread and one Paperclip task; replies queue within that task; retries, reconnects, and duplicate events do not fork the binding.

### DC4 — Discord capabilities

Run C3, C5, and C6, then verify specifically:

- acknowledgement reactions add and remove without producing a second turn;
- safe progress/final output uses bounded post/edit behavior; Discord is not labeled as native streaming;
- cards render as Discord embeds and supported buttons execute through Gateway interactions with server-side reauthorization;
- file receive/send is bounded and type checked; persisted attachment recovery accepts only Discord CDN hosts and never stores authorization headers or the bot token;
- user message edits produce one correction audit event, and deletes produce a tombstone even when Discord supplies only a partial cached message;
- long output, provider rate limits, and an ambiguous outbound failure follow the shared publication/outbox rules;
- native question forms use Discord modals; command/private-response capability is advertised only after confirmed registration, and proactive DMs are not advertised.

### DC4a — Automatic native session commands

Implementation is under qualification; deterministic tests do not replace this
live journey. Discord global commands can work in bot DMs as well as guilds,
and the bot install scope includes command authorization. No extra endpoint
toggle or user-install scope is required. See Discord's
[application-command contract](https://docs.discord.com/developers/interactions/application-commands).

1. On the existing dedicated bot, verify `/paperclip status`, `/paperclip new`
   and `/paperclip close` appear after automatic registration. Existing unrelated
   app commands must remain unchanged. Record the provider command ID, not tokens.
2. In an active task thread, invoke status. Only the invoking user should see
   the status response; no agent run or ordinary publication should be created.
3. Invoke close. The initial private response acknowledges processing, then
   reports that the request was recorded. It must not claim closure before the
   durable public control confirmation is delivered. Check one confirmation,
   one conversation transition, and no duplicate after a repeated interaction receipt.
4. Invoke new in a guild thread: receive new-root guidance, with no replacement
   task bound to that thread. In an allowed DM, invoke new, wait for confirmation,
   then send a message and verify exactly one new task generation.
5. Disable the DM/channel reach or revoke the mapped identity before a queued
   invocation completes. Expect a private denial and no task mutation. Verify an
   old interaction cannot operate on a newer DM generation or credential epoch.
6. During a controlled command-registration refresh failure, ordinary mentions
   and thread replies must keep their healthy Gateway connection. Commands deny
   while their registration is unconfirmed; unknown registration writes reconcile
   by GET, not blind repost. Keep provider responses private according to the
   [interaction response contract](https://docs.discord.com/developers/interactions/receiving-and-responding).

The app-global ownership marker survives local company/endpoint deletion to
prevent an old uncertain registration from silently authorizing a new endpoint.
It retains public app/opaque owner identifiers only, not credentials or content.
Reusing an archived bot does not implicitly transfer its command ownership;
ordinary mention setup remains usable while command ownership is unresolved.

### DC5 — DMs and identity

1. With **Allow direct messages** off, DM Maya and verify no task. Turn it on and start a fresh DM message.
2. Verify the DM uses its own Paperclip task generation and cannot reuse a guild-channel thread.
3. Run C3 for a linked Discord user and a separate unlinked user. Confirm Discord numeric user ID, not display name, is the identity key.
4. Revoke the Paperclip identity link during a queued follow-up and verify authorization is rechecked before the agent wakes or publishes.

**Pass:** the DM toggle is enforced, guild and DM scopes cannot cross, and mutable Discord names never confer Paperclip identity.

### DC6 — Gateway lifecycle and recovery

1. Keep the connection active through a controlled network interruption and verify discord.js resumes/reconnects without a manual endpoint setting.
2. Verify the direct Gateway client remains long-lived; routine renewal must not create a visible 15-minute disconnect window.
3. Rotate the disposable bot token. Verify Activity shows a redacted reconnect action and no secret.
4. Enter the replacement token through reconnect and confirm the same endpoint, channel allowlist, historical Conversations rows, and task links remain.
5. Disable Message Content Intent and verify reconnect fails closed with the provider-permissions error. Re-enable it before continuing.
6. Exercise one bounded REST failure and one provider `retry_after` longer than 60 seconds. Verify Paperclip stops a hung request at 25 seconds, preserves Discord's structured status/`retry_after`, does not retry at the old 60-second boundary, and schedules only the allowed durable retry at the provider's full backoff window.
7. In the deterministic compatibility test, verify the pinned adapter marker and every required patched method fail fast on SDK drift. Dependency updates must rerun this contract before provider qualification.
8. Inspect application logs across invalid signatures, failed interactions, thread creation, callback failures, and provider errors. Logs may retain stable IDs, numeric status/error codes, retry durations, and lengths, but must not contain message text, derived thread names, component values, interaction tokens, bot tokens, webhook URLs, or raw provider response bodies.

### DC7 — Discord evidence and cleanup

Capture the Developer Portal intent screen, exact OAuth permission request, server install, enabled/disabled channel states, two root threads, queued replies, reaction/edit/delete behavior, DM result, Conversations rows, and Activity recovery state. Remove the Paperclip connection and verify its Gateway runtime stops, credential references and stored secret rows are cleared, the endpoint is archived, and retained Conversations/task history is marked `endpoint_removed` rather than erased. Remove only the disposable bot/application or test messages authorized for provider cleanup, and revoke identity links. Never capture or record the bot token.

## 10. Cross-platform deployment qualification

Run once per release candidate in addition to the provider runbooks.

### D1 — Direct provider transport

Use the public staging instance for each webhook provider and the direct Gateway runtime for Discord. Verify provider verification/connection, first delivery, duplicate delivery, reconnect, and Activity health. No endpoint-level delivery choice may appear.

### D2 — Private self-hosted relay

Run only after the relay is shipped. Until then, record D2 as **NOT SHIPPED — NON-BLOCKING** and do not expose relay as an endpoint setup option.

1. Start a private Paperclip instance with no inbound public route.
2. Configure the authenticated relay once in instance administration.
3. Create one disposable chat endpoint and complete the provider's normal browser setup without choosing relay in the endpoint wizard.
4. Send a provider message and verify relay heartbeat, verified provider signature, task creation, output publication, reconnect after a brief offline period, and fenced single-consumer behavior.
5. Rotate the relay key from instance administration and verify endpoint continuity.

**Pass:** the provider journey is unchanged; relay is instance transport, not endpoint configuration. The relay cannot act as a Paperclip user or invoke arbitrary APIs.

### D3 — Provider developer escape hatches

Slack Socket Mode and Telegram polling receive separate instance-admin smoke tests only when shipped. Discord Gateway is the normal direct transport, not a developer escape hatch. The endpoint setup and Settings pages must remain unchanged. These modes do not count as substitutes for the required direct transport or relay qualification.

## 11. Provider capability acceptance matrix

“Automatic” means the richest safe native behavior is used without an endpoint toggle. “Fallback” means the provider visibly receives the documented safe alternative.

| Capability               | Slack                         | GitHub                                    | Discord                                  | Teams                                                   | Telegram                                 |
| ------------------------ | ----------------------------- | ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------- |
| Root activation          | Native mention                | Mention in issue/PR/review                | Root bot mention                         | Native mention                                          | DM message or group `/task@bot` command  |
| Durable boundary         | Slack thread or DM generation | Existing issue/PR/review thread           | Created Discord thread or DM generation  | Channel post thread or chat generation                  | Chat generation or forum topic           |
| Reaction acknowledgement | Automatic                     | Automatic                                 | Automatic                                | Automatic where supported                               | Automatic where allowed                  |
| Streaming/progress       | Native stream, else post/edit | Coarse comment edit                       | Bounded post/edit; no native streaming   | Bounded post/edit; no native streaming                  | Throttled post/edit; optional DM draft   |
| Rich cards               | Block Kit                     | GFM + Paperclip link                      | Discord embed                            | Adaptive Card                                           | Formatted text/inline keyboard           |
| Buttons/selections       | Native                        | Fallback link                             | Native Gateway interaction               | Native card action                                      | Inline keyboard                          |
| Modal/form               | Native modal                  | Fallback link                             | Native modal                             | Task module                                             | Sequential prompt/link fallback          |
| Commands                 | Registered slash command      | Text mention vocabulary only              | Registered `/paperclip status/new/close` | Card/message vocabulary                                 | `/new`, `/status`, `/close`              |
| Files                    | Native send/receive           | Scoped inbound uploads + task output link | Native send/receive                      | Personal consent; channel/group pictures; task fallback | Native media/document                    |
| DM                       | Native                        | Unsupported                               | Native                                   | Personal scope                                          | Native                                   |
| Ephemeral/private denial | Ephemeral, then DM/text       | Safe public text/link                     | DM, then safe text                       | Targeted, then DM/text                                  | Recipient-bound callback; exact-actor DM |
| Edit/delete audit        | Correction/tombstone          | Correction/tombstone                      | Correction/tombstone                     | Correction/tombstone where delivered                    | Correction/tombstone where delivered     |
| Concurrent turns         | Queue by default              | Queue by default                          | Queue by default                         | Queue by default                                        | Queue by default                         |

A stable adapter fails qualification if it silently omits a supported maximal feature, exposes a feature toggle that should be automatic, claims an unsupported native behavior, or falls back without preserving task identity, authorization, and safe publication.

## 12. Failure triage

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

## 13. Final sign-off checklist

A provider is release-ready only when all are true:

- [ ] Default-off experimental visibility passed without breaking GitHub tool setup; enabling it reveals the chat surfaces.
- [ ] Actual live runs use the new Paperclip Runner with the recorded Codex model and binary SHA; deterministic model fixtures are not counted as live proof.
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

## 14. Provider operator references

These official references are the browser runner's drift checks when a provider renames or moves a setup control. The permissions and events displayed by the versioned Paperclip setup remain the test's exact least-privilege contract; a changed provider UI is not permission to grant more access.

- Slack: [app manifests](https://api.slack.com/reference/manifests), [Events API](https://api.slack.com/apis/connections/events-api), and [slash commands](https://api.slack.com/tutorials/your-first-slash-command).
- GitHub: [modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration), [managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), [installing and scoping GitHub Apps](https://docs.github.com/en/apps/using-github-apps/about-using-github-apps), and the conditional [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
- Discord: [building a bot](https://docs.discord.com/developers/quick-start/getting-started), [Gateway intents](https://docs.discord.com/developers/events/gateway), [application flags](https://docs.discord.com/developers/resources/application), and [OAuth installation](https://docs.discord.com/developers/topics/oauth2).
- Microsoft Teams: [Azure bot configuration](https://learn.microsoft.com/en-us/microsoftteams/platform/teams-sdk/teams/azure-configuration), [bot surfaces](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/design/bots), and [RSC channel/chat delivery](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-for-bots-and-agents).
- Telegram: [bot creation and privacy behavior](https://core.telegram.org/bots) and [Bot API webhook behavior](https://core.telegram.org/bots/api#setwebhook).
