# GitHub chat and review bots

A GitHub bot belongs to one Paperclip agent. GitHub issues, pull requests, and
review threads enter ordinary Paperclip tasks; the agent's runs, permissions,
budget, and activity remain visible there. The Reviews page is a projection of
assessments attached to those tasks, not a separate execution system.

For a step-by-step explanation of mentions, automatic reviews, scores, and
required GitHub checks, read
[Understanding GitHub PR review bots](UNDERSTANDING-GITHUB-PR-REVIEW-BOTS.md).

## Set up a bot

Enable **GitHub review bots** in instance **Experimental** settings, then open
the GitHub Code Review Bot connector. This default-off setting is independent of
**Chat connectors**. Hiding either feature does not pause existing provider delivery.

1. Choose the bot agent. Prefer a
   [low-trust review agent](https://docs.paperclip.ing/administration/trust-and-low-trust-review/)
   with an isolated sandbox and a scoped task boundary. Standard-trust agents
   show a warning with **Change <agent> to a low trust agent**. This explicitly
   saves the low-trust preset; it does not configure a sandbox or task boundary.
2. Choose **My account** or **An organization**. Enter the organization when
   needed and review the App name suggested from your agent. Click
   **Continue to GitHub**. Paperclip fills permissions, events, and callbacks.
3. Confirm creation on GitHub, then select repositories and approve installation.
   Paperclip stores the credentials securely and imports the initial selection,
   including an explicit All repositories choice. Organization policies may
   require administrator approval; resume the same draft when it is granted.
4. Paperclip reuses your verified GitHub identity when available. Otherwise,
   authorize the dedicated App and confirm the observed account once. Bot work
   uses installation credentials, never your personal GitHub token.
5. Connection verification and completion happen automatically. Paperclip opens
   the bot's Settings with a connected confirmation modal showing the actual App
   identity, enabled repository count, and a copyable optional review mention.
   Dismiss it with **Done**, the close button, or Escape to stay in Settings.
   Runtime and isolation readiness remain separate prerequisites.

Installation may return before GitHub's separately delivered signed webhook
ping. Paperclip keeps the same draft and credentials, shows a waiting state,
and continues automatically after authenticating the ping. Refreshing or
resuming that draft must not create another App or bypass signature verification.

New connections default to authorized mentions, advisory reviews, linked-member
access, guests off, and enabled bot GitHub tools. Existing instructions, explicit
behavior, and narrower saved repository restrictions remain intact. Later
repository additions require enablement in Access. Advanced review rules and
prompts live in Settings.

The App belongs to the selected account or organization and uses its own bot
identity. The editable App name determines GitHub's slug and `@mention`; there
is no separate editable bot username. Paperclip shows and copies the verified
mention in the connected bot's header. Type `@app-slug`, without the `[bot]`
suffix shown on GitHub's API author records.

**GitHub App name and logo** is optional on the connected page and in Settings.
Download the agent's avatar as a PNG, then follow the link to this App's GitHub
settings to upload it under **Display information**. GitHub's
[manifest parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
do not include an avatar; the
[logo upload](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/creating-a-custom-badge-for-your-github-app)
remains a GitHub settings action. After renaming the App on GitHub, use the
existing **reconnect this App** flow to refresh its verified identity using its
stored credentials. Legacy manual connections without recorded ownership link
to the App settings list instead of assuming an owner.

Local instances receive public callbacks and signed events through an enrolled
Paperclip Cloud connector, using outbound requests instead of a public tunnel.
Your localhost instance does not need HTTPS or a tunnel for this flow. Setup
asks you to connect Cloud only if the instance is not already enrolled.
The Cloud gateway capability must be deployed before localhost onboarding.
Direct public-HTTPS webhook connections and manual existing-App credential
recovery remain supported. An expired, unconsumed Cloud handoff can be renewed in the same draft after the configuring manager confirms that no App was created on GitHub. Claimed, consumed, and uncertain exchanges still require existing-App recovery. Setup tasks and copied prompts are not part of this
wizard. Normal agent API keys cannot call its board-only management APIs.

GitHub review bots use the existing agent runtime; this connector does not add
provider software to the Cloud server image. Codex with managed MCP tools and
the native Runner Codex backend do not require a server-side remote provider
pack. Remote native ACPX (including Claude) and OpenCode currently require an
operator-supplied, build-owned provider pack configured through
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`; the standard Cloud server image
does not supply one. A pack installed in the sandbox alone does not satisfy
that existing runtime requirement. Treat that provider setup as a separate
Runner prerequisite, not an automatic connector installation step.

Connection setup reports tool/runtime support and isolation separately; an actual test
task is still required to prove that the chosen provider can execute in the
selected environment.

## Manage a connected bot

- **Settings:** edit instructions, choose when the bot runs, and set review output.
  Event-specific instructions, filters, and formal approvals are available in
  disclosures. Repository-override editing is temporarily hidden in the UI;
  existing overrides and the configuration API remain supported. Changing
  defaults preserves saved overrides.
- **Access:** choose enabled repositories and allowed people. Repository switches save immediately. Other
  changes use **Save changes**. A linked account alone does not grant selected-member
  access. **Add external contributor** still requires a sponsor and restricted
  permissions. Bot tools are enabled during setup; a previously disabled connection
  exposes an explicit repair action without silently changing its permissions.
- **Reviews:** see every assessment as one row, newest first. Open a row for its
  summary, commit, findings, coverage, and task/run/publication links. Each review
  has its own URL. A previous passing result does not stand in for a pending review
  of a newer commit.
- **Conversations:** follow the task title to Paperclip or the repository/thread
  label to GitHub.

Settings and Access share unsaved edits while you switch connection tabs. Save
before reloading or leaving the connection. No permissions change merely by
opening a tab.

The repository list loads 20 rows at a time as you scroll. Search covers the
entire connection. **Disable all** and **Enable all** also apply to the entire
connection, including unloaded rows and repositories outside the search results.
Enabling all includes only repositories still available in the App installation;
it cannot restore revoked GitHub access. These changes save immediately.

## Who can start work

Linked members may be allowed together or selected individually. Teammates
connect and confirm their own accounts; an administrator cannot assert someone
else's identity by entering a username.

To admit an unlinked GitHub person, explicitly add their verified GitHub account,
choose an active sponsor, and use the restricted guest profile. Guests receive no company membership or
sponsor credentials. Authority is checked again before tool calls and
publication, so revocation also affects queued or ongoing work.

Choose automatic events and author filters in **Settings** to control which
authored PRs and issues start work. Authorized mentions remain available with
automatic events off and bypass automatic author filters. The shared external-
contributor switch controls whether sponsored guests may start automatic work;
there are no per-person automatic-run switches in Access. Legacy saved
`automaticReviews` values are ignored.

Automatic tasks use the configured responsible Paperclip member for accountability,
not that member's personal GitHub credentials. A member named **Board** in a local
test drive is still the responsible user, not a separate GitHub actor. The PR author and
webhook sender are recorded independently. Follow-ups preserve task ownership
while checking the current requester's authority.

## Mentions and pushes

Use **mentions only** for reviews initiated by an authorized `@your-bot` request.
Choose automatic reviews and enable **updated commits** to review new pushes.
Opened, reopened, ready-for-review, and updated-commit events are independently
configurable. Draft and bot-authored PRs are excluded by default. Settings can
be overridden per enabled repository.

**New GitHub issues** is a separate opt-in automatic event, disabled on existing
and new connections until selected. It uses the same repository, author,
linked-member or sponsored-guest, responsible-member, and label restrictions as
automatic PR events; PR branch filters do not apply to issues. Its instructions
start an ordinary issue task with task-bound comment tools, without a PR
assessment or commit check. Older manually configured Apps must subscribe to
the `issues` webhook event before enabling this setting.

An authorized mention can bypass automatic author/branch/label scheduling
filters. It cannot bypass repository restrictions, excluded files, or access
permissions. Ordinary discussion does not change a review score. Repeat review
mentions and pushes continue the existing task; inline replies return to the
task owning that thread.

Event prompts supplement the agent's instructions. Repository content and PR
prose are untrusted input and cannot change tool authority or publication policy.
The execution records the configuration revision and event context used.

## Assessments, checks, and formal reviews

The agent reads through task-bound bot tools, explicitly begins an assessment,
and submits the reviewed commit, findings, rationale, and coverage. Paperclip
validates the result and computes the **Paperclip Review** check. The default
threshold is 5/5; choose 1–5 or report-only as needed.

| Score | Assessment rubric |
| --- | --- |
| 0 | No usable assessment; explain what prevented evaluation. |
| 1 | Critical defects make the change unsafe to ship. |
| 2 | Major defects require substantial correction. |
| 3 | Meaningful defects require correction before merging. |
| 4 | Minor concerns remain; explain impact and remaining risk. |
| 5 | No actionable defects found within the stated coverage and limitations. |

Incomplete coverage cannot pass. Filtering which findings become inline comments
does not remove them from the assessment. A new head requires a new assessment;
old runs cannot publish over the latest head. One current summary is updated in
place, with history and task/run links retained. Stable finding keys prevent
duplicate inline comments on repeated reviews.

The check's **Details** link opens its Paperclip task on the current instance
hostname, or the connector's Reviews page when no task has been created yet.

Formal **APPROVE** and **REQUEST_CHANGES** are separate governed tools, each off
by default. Enabling either does not automatically perform it. A score of 5/5
alone never approves a PR. The agent must finish an assessment and explicitly
choose the allowed action. **Allow approvals** permits a formal ready-to-merge
decision; **Allow request changes** permits a formal change request, which can
prevent merging when the repository's review rules require resolution. Keeping
these off leaves scores, comments, and checks available while making formal
review decisions opt-in. The controls include contextual tooltips.

To enforce the rating at merge time, configure GitHub branch protection or a
ruleset to require **Paperclip Review**, selecting this bot App as the source
where supported. Paperclip does not change repository rules. GitHub account and
repository plan restrictions may limit required-check enforcement. If automatic
execution is disallowed, a gated head requests an authorized manual review.

## Hosted ingress

Dedicated Apps use Cloud as a sealed transport gateway. Cloud routes opaque
callbacks and signed webhook bytes to the enrolled instance; the instance
exchanges GitHub codes, stores credentials, verifies webhook signatures, and
applies repository and actor policy. Local instances poll outbound and do not
need an inbound tunnel.

Legacy direct-webhook Cloud deployments proxy only `POST /api/chat-webhooks/:publicId/github` and the narrow
`GET /api/chat-github/manifest/callback` registration callback without browser
login. The instance verifies the untouched webhook body and GitHub signature;
registration uses expiring, single-use user/company/origin-bound state.
Installation return, configuration, and identity confirmation remain
authenticated. URLs use the trusted current vanity hostname, with explicit
webhook-ingress overrides preserved.

Existing chat connections do not gain review execution or broader permissions
until explicitly configured. GitHub.com and UI-managed settings are the initial
scope; cross-repository indexing and auto-fix are not included.
