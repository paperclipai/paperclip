# GitHub chat and review bots

A GitHub bot belongs to one Paperclip agent. GitHub issues, pull requests, and
review threads enter ordinary Paperclip tasks; the agent's runs, permissions,
budget, and activity remain visible there. The Reviews page is a projection of
assessments attached to those tasks, not a separate execution system.

For a step-by-step explanation of mentions, automatic reviews, scores, and
required GitHub checks, read
[Understanding GitHub PR review bots](UNDERSTANDING-GITHUB-PR-REVIEW-BOTS.md).

## Set up a bot

1. Choose the permanent agent assignment. Prefer a
   [low-trust review agent](https://docs.paperclip.ing/administration/trust-and-low-trust-review/)
   with an isolated sandbox and a scoped task boundary. Standard-trust agents
   show a warning; choosing one does not silently reduce their permissions.
2. Make the instance reachable through public HTTPS, then create an App with
   manifest registration or connect an existing App. Credentials are vaulted.
3. Install the App on GitHub. Grant access only to the intended repositories.
4. Refresh the repository list in Paperclip and enable the repositories this bot
   should handle. GitHub installation access and Paperclip enablement are
   separate controls. Use **Configure on GitHub** to change installation access,
   then refresh again.
5. Verify signed delivery, App identity, repository permissions, and the assigned
   agent's effective tools/runtime separately. For existing Apps, add Contents
   read, Pull requests write, and Checks write alongside chat permissions and
   subscribe to pull-request events. Approve any installation permission upgrade.
6. Choose your existing personal GitHub connection and explicitly confirm the
   verified account identity. That connection links your identity; the bot uses
   its own App credentials for agent tools and publication.
7. Configure access, event prompts, review behavior, and publication permissions.
   Save progress to resume later. The final mention test is optional.

GitHub review bots use the existing agent runtime; this connector does not add
provider software to the Cloud server image. Codex with managed MCP tools and
the native Runner Codex backend do not require a server-side remote provider
pack. Remote native ACPX (including Claude) and OpenCode currently require an
operator-supplied, build-owned provider pack configured through
`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`; the standard Cloud server image
does not supply one. A pack installed in the sandbox alone does not satisfy
that existing runtime requirement. Treat that provider setup as a separate
Runner prerequisite, not an automatic connector installation step.

Setup verification checks tool/runtime support and isolation; an actual test
task is still required to prove that the chosen provider can execute in the
selected environment.

## Who can start work

Linked members may be allowed together or selected individually. Teammates
connect and confirm their own accounts; an administrator cannot assert someone
else's identity by entering a username.

To admit an unlinked GitHub person, explicitly add their verified GitHub account,
choose an active sponsor, and use the restricted guest profile. Automatic reviews
for that person are a separate choice. Guests receive no company membership or
sponsor credentials. Authority is checked again before tool calls and
publication, so revocation also affects queued or ongoing work.

Automatic events use the configured responsible member. The PR author and
webhook sender are recorded independently. Follow-ups preserve task ownership
while checking the current requester's authority.

## Mentions and pushes

Use **mentions only** for reviews initiated by an authorized `@your-bot` request.
Choose automatic reviews and enable **updated commits** to review new pushes.
Opened, reopened, ready-for-review, and updated-commit events are independently
configurable. Draft and bot-authored PRs are excluded by default. Settings can
be overridden per enabled repository.

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
alone never approves a PR.

To enforce the rating at merge time, configure GitHub branch protection or a
ruleset to require **Paperclip Review**, selecting this bot App as the source
where supported. Paperclip does not change repository rules. GitHub account and
repository plan restrictions may limit required-check enforcement. If automatic
execution is disallowed, a gated head requests an authorized manual review.

## Hosted ingress

Cloud proxies only `POST /api/chat-webhooks/:publicId/github` and the narrow
`GET /api/chat-github/manifest/callback` registration callback without browser
login. The instance verifies the untouched webhook body and GitHub signature;
registration uses expiring, single-use user/company/origin-bound state.
Installation return, configuration, and identity confirmation remain
authenticated. URLs use the trusted current vanity hostname, with explicit
webhook-ingress overrides preserved.

Existing chat connections do not gain review execution or broader permissions
until explicitly configured. GitHub.com and UI-managed settings are the initial
scope; cross-repository indexing and auto-fix are not included.
