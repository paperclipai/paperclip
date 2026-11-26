---
title: GitHub Review Bots
summary: Connect any Paperclip agent as a dedicated GitHub PR review bot with scored assessments, opt-in merge checks, and full task visibility
---

A GitHub Review Bot connects one Paperclip agent to GitHub through a dedicated GitHub App. Every pull request review, `@mention`, and inline thread enters an ordinary Paperclip task, so the agent's runs, traces, skills, permissions, and costs stay visible in Paperclip.

You can run a review bot on any agent, harness, or model supported by Paperclip—including Claude Code, Codex, OpenCode, Pi, Antigravity, Cursor, Gemini CLI, Copilot, Hermes, Grok, and Kimi Code—and swap models or instructions later without reconfiguring GitHub.

## 1. Quickstart

GitHub Code Review Bot is available in **Connectors** by default with no experimental setting required. Setup requires zero GitHub Actions YAML in your repository.

### Step 1: Choose an agent

1. Open **Connectors** in Paperclip and select **GitHub Code Review Bot**.
2. Choose the Paperclip agent that will own this bot.
   - If the selected agent does not use the low-trust review preset, Paperclip displays a warning with **Change `<agent>` to a low trust agent**. Clicking it saves the `low_trust_review` policy preset on the agent; sandbox and workspace isolation remain separate runtime settings (see Section 4 below).
3. Click **Continue**.

### Step 2: Create and install the dedicated GitHub App

1. If you are running on localhost or a private self-hosted instance that is not yet enrolled with Paperclip Cloud, click **Connect Paperclip Cloud** when prompted. Cloud relays signed webhook events over outbound requests so you do not need ngrok, a public tunnel, or a local HTTPS certificate.
2. Under **GitHub account**, choose **My account**, a detected organization, or **Another organization**.
3. Review the suggested **App name** (up to 34 characters). This name sets the App's GitHub slug and `@mention`; there is no separate bot username field.
4. Click **Continue to GitHub**. Paperclip submits a GitHub App Manifest that pre-fills the required permissions, webhook events, and callbacks automatically.
5. Confirm App creation on GitHub, select the repositories the App may access, and approve installation.
   - If your organization requires administrator approval, pause on the waiting screen and resume the same draft once approval is granted.

### Step 3: Confirm your GitHub identity and verify

1. Paperclip reuses your verified GitHub identity when available. Otherwise, click **Connect my GitHub account** and confirm the account once with **Confirm my account** so your `@mentions` map to your Paperclip permissions.
   - Bot reviews and comments always use the App's installation credentials, never your personal GitHub token.
2. Paperclip verifies installation access and GitHub's signed webhook ping automatically. If the browser returns before the webhook ping arrives, Paperclip keeps the same draft and completes verification once the signed ping is authenticated—refreshing the page will not create a duplicate App.
3. When verification completes, Paperclip opens the bot's **Settings** page with a confirmation modal showing the verified `@app-slug` mention (type `@app-slug` on GitHub without the `[bot]` suffix), enabled repository count, and a link to optional App branding.

### New connection defaults and management tabs

New connections start with authorized `@mentions`, advisory reviews (no merge-blocking GitHub rule), linked-member access, external contributors off, formal GitHub approvals and change requests off, and bot GitHub tools enabled.

Once connected, manage the bot across four tabs:

| Tab | What you manage |
| --- | --- |
| **Settings** | Instructions, `/` skills, event-specific instructions, automatic triggers and filters, passing score or report-only mode, ignored files, finding categories, and optional formal approvals. |
| **Access** | Enabled repositories, per-repository task defaults, linked company members, sponsored external contributors, and automatic task responsibility. |
| **Reviews** | Every assessment newest first, with its own URL, score, commit SHA, findings, coverage, and links to the Paperclip task, run trace, and GitHub summary/check. |
| **Conversations** | Direct links between Paperclip tasks and their GitHub pull requests, issues, and inline review threads. |

Repository toggles on **Access** save immediately. Other edits across **Settings** and **Access** stay in draft while you switch tabs until you click **Save changes**.

## 2. The three independent choices

A review bot can inspect a pull request, leave inline comments, and score it `3/5` without blocking anyone from merging. That behavior is deliberate because three decisions stay separate:

1. **Installing the GitHub App** grants repository access and sends webhook notifications to Paperclip.
2. **Choosing triggers in Paperclip** decides which notifications start the agent.
3. **Requiring `Paperclip Review` in GitHub Rulesets** tells GitHub whether merging must wait for a passing check.

### Choice 1: Install the App and enable repositories

Installing the GitHub App grants GitHub permissions to read code, post comments and reviews, and publish check runs, and subscribes Paperclip to GitHub webhooks:

| GitHub activity | Webhook received by Paperclip |
| --- | --- |
| Comment on an issue or PR conversation | `issue_comment` |
| Reply in an inline PR review thread | `pull_request_review_comment` |
| PR opened, reopened, marked ready, or pushed | `pull_request` (`opened`, `reopened`, `ready_for_review`, `synchronize`) |
| New issue opened (when opted in) | `issues` |
| PR review summary submitted | `pull_request_review` |

GitHub installation access and Paperclip's **Access → Repositories** list are independent controls. A repository must be granted to the App on GitHub **and** enabled in Paperclip before the bot can run there. Repositories added to the App on GitHub later stay disabled after **Refresh repositories** until you enable them in **Access**. Use **Search repositories** to filter large lists, or **Enable all** / **Disable all** to update every available repository across the connection at once.

### Choice 2: Choose triggers in Paperclip (`Settings → When to run`)

The same GitHub App supports manual mentions, automatic reviews, or both:

- **When mentioned:** Authorized people can always request work with `@app-slug` on a PR or issue, even when automatic runs are off. Authorized mentions bypass automatic author, branch, and label filters, but still obey repository access, **Ignored files**, and caller permissions.
- **Run automatically:** Toggle **Run automatically** on and choose any combination of independent events:
  - **New pull request** (`opened`)
  - **Updated commits** (`synchronize`)
  - **Reopened** (`reopened`)
  - **Ready for review** (`ready_for_review`)
  - **New issues** (opt-in; starts an ordinary Paperclip task with comment tools and no PR assessment or commit check)
- **Automatic review filters:** Draft PRs and bot-authored PRs are excluded by default (`Include draft PRs` and `Include bot authors` are off). Narrow automatic runs further by **Authors** (included/excluded usernames or globs), **Branches** (target/excluded patterns supporting `*` and `**`), and **Labels** (required/excluded).
- **Instructions and skills:** Write shared guidance in **Instructions** (type `/` to attach a Paperclip skill) and add event-tailored guidance under **Event-specific instructions**.

Paperclip maintains one main working comment per bot per PR, updating it in place as the run progresses and replacing it with the final review summary. Pushes and repeat `@mentions` continue the same Paperclip task so review history stays together. Ordinary discussion replies never alter a PR's score.

### Choice 3: Require `Paperclip Review` in GitHub Rulesets (opt-in)

Installing the bot or enabling automatic reviews **never** modifies your GitHub branch protection or rulesets. Merge gating is always opt-in on GitHub so you can evaluate review quality before making merges depend on it.

To require a passing review before merging into a branch such as `main`:

1. Let the bot complete at least one review so GitHub recognizes the **Paperclip Review** check name.
2. In your repository on GitHub, open **Settings → Rules → Rulesets** (or classic branch protection).
3. Create or edit a branch ruleset targeting the protected branch (for example, `main`).
4. Enable **Require status checks to pass** and add **Paperclip Review**.
5. Select your bot's GitHub App as the expected source where supported so another integration cannot satisfy the check.
6. Set enforcement to **Active** and configure bypass rules deliberately.

Requiring the check tells GitHub to wait for a passing result; it does not start the agent by itself. The four combinations behave as follows:

| Trigger in Paperclip | GitHub requires `Paperclip Review`? | Result |
| --- | --- | --- |
| Mentions only | No | On-demand feedback when someone `@mentions` the bot. A failing check does not block merging. |
| Automatic | No | Automatic feedback on selected PR events. A failing check does not block merging. |
| Mentions only | Yes | Merging waits until an authorized person `@mentions` the bot and the check passes. |
| Automatic | Yes | Reviews run automatically on selected events and merging waits for a passing check. |

If automatic execution is disallowed for a PR on a branch requiring the check, Paperclip can publish an **Action required** check asking for an authorized manual review.

### Formal Approve and Request changes reviews are separate

GitHub's formal **Approve** and **Request changes** review actions are separate from the **Paperclip Review** status check. Under **Settings → Approvals and change requests**, both **Allow approvals** and **Allow request changes** are **off by default**.

- A `5/5` score or green **Paperclip Review** check never submits a formal GitHub approval on its own.
- Enabling either toggle grants the agent access to a governed tool that it may invoke explicitly after completing an assessment.
- Keeping both off leaves scores, summary comments, inline findings, and commit checks active while reserving formal PR approvals for humans.

## 3. Structured assessments and the `Paperclip Review` check

GitHub has no built-in concept of a `3/5` or `5/5` review comment. Paperclip bridges that gap by validating a structured assessment from the agent and publishing a commit-bound GitHub check run named **Paperclip Review**.

### How Paperclip validates an assessment

1. The agent inspects the pull request through task-bound GitHub tools and starts an assessment with `begin_review`, which returns the repository's active `findingCategories` policy snapshot.
2. The agent submits a structured assessment via `submit_review` containing:
   - `reviewedCommit` (the exact PR head SHA inspected)
   - `score` (`0`–`5`) and `complete` boolean
   - `summary` (the change, findings, and verdict) and `rationale` (evidence for the score and remaining risk)
   - `coverage` (`reviewedPaths`, `omittedPaths`, and `limitations`)
   - `findings` (each with a stable `key`, `path`, `line`, `side`, `severity`, `category`, and `body`)
3. **Paperclip-side validation:** Paperclip validates the schema, rejects unknown finding categories (default categories are `correctness`, `security`, `reliability`, and `maintainability`, configurable in **Settings → Inline comment options**), verifies that coverage is complete, and compares the score against your configured **Passing score**. The agent cannot directly declare an arbitrary passing check.

### Score rubric

| Score | Meaning |
| --- | --- |
| **0** | No usable assessment; analysis is incomplete or cannot establish coverage. |
| **1** | Critical defects make the change unsafe to ship. |
| **2** | Major defects require substantial correction. |
| **3** | Meaningful defects require correction before merging. |
| **4** | Minor concerns remain; impact and remaining risk are explained. |
| **5** | No actionable defects found within the stated coverage and limitations. |

### Passing score and check states

Under **Settings → Review results**, **Passing score** defaults to `5` out of `5` (configurable from `1` to `5`), or you can check **Report only** to publish a `neutral` check without enforcing a score threshold.

| Review state | `Paperclip Review` check result |
| --- | --- |
| Waiting for the agent | `Queued` |
| Agent actively reviewing | `In progress` |
| Complete assessment meets passing score | `Success` |
| Complete assessment falls below passing score | `Failure` |
| Incomplete assessment, execution error, or manual review required, with a passing score configured | `Action required` (non-passing) |
| Any completed check in **Report only** mode, including an incomplete assessment, execution error, or manual review required | `Neutral` |

### Commit-bound guarantees and inline findings

- **Strict head binding:** Every check run attaches to the exact commit SHA reviewed. Pushing new commits requires a fresh assessment (automatically when **Updated commits** is enabled, or via `@app-slug`). An earlier passing result never stands in for a newer commit, and stale runs cannot overwrite the latest head.
- **Incomplete assessments cannot pass:** If the agent cannot inspect required files or a build/tool fails, the assessment cannot satisfy a score threshold.
- **Inline comment controls:** Under **Settings → Review results** and **Inline comment options**, toggle **Post a review summary**, **Post inline findings**, and **Minimum inline severity** (`Info`, `Warning`, or `Error`; defaults to `Warning`). Filtering which findings appear as inline comments does not remove them from the saved assessment or score. Stable finding keys prevent duplicate inline comments across repeat reviews.
- **Traceability:** Clicking **Details** on the GitHub check opens the Paperclip task (or the bot's **Reviews** view before a task exists), giving reviewers immediate access to the full execution trace, tool calls, token usage, and cost.

> **Task completion note:** A review score controls the GitHub check, not the Paperclip task status. Configure when the agent should finish its Paperclip task (for example, marking the task done after a confirmed `5/5` publication) in your agent or bot instructions.

## 4. Permissions, linked members, external contributors, and low-trust review agents

Paperclip separates who can trigger work from how the agent is contained while reading untrusted PR content.

### Linked company members

Under **Access → People → Company members**:

- **All linked members vs selected members:** Toggle **Allow mentions from all linked members** on to let any company member who links their GitHub account invoke the bot, or turn it off to enable specific linked members individually.
- **Self-verified identity:** Click **Link a member** to copy an invitation link so each teammate confirms their own GitHub identity. An administrator cannot assert someone else's GitHub identity by entering a username.

### Sponsored external contributors

To allow an unlinked GitHub user (such as an external collaborator or maintainer) to trigger reviews:

1. Under **Access → People → External contributors**, click **Add external contributor**.
2. Enter the GitHub username and click **Look up**. Paperclip resolves the account through the bot's own short-lived, metadata-only App installation token—never a personal token or shared unauthenticated IP quota.
3. Choose an active company member as the **Sponsor** and click **Add contributor**, then **Save changes**.

Sponsored external contributors receive a restricted guest profile with **no company membership** and **no access to the sponsor's personal credentials**. By default they can `@mention` the bot; to let their PRs trigger automatic runs, explicitly enable **Allow automatic runs for external contributors** in **Access**.

### Automatic task responsibility and live authority checks

Under **Access → Automatic task responsibility**, select the **Responsible member** accountable for automatically created Paperclip tasks. This records company accountability without granting access to that member's personal GitHub credentials. Paperclip records the GitHub PR author and webhook sender independently.

Authority is re-checked before tool calls and publication, so revoking a member's link, removing an external contributor, or disabling a repository stops queued and in-flight publication as well.

### Low-trust review agents vs runtime sandboxing

Repository contents, PR descriptions, diffs, and comments are untrusted input and can contain prompt injection. Untrusted input can never change tool authority or publication policy, and Paperclip recommends running review bots on a `low_trust_review` agent.

The `low_trust_review` preset enforces Paperclip API containment:

- Scopes API reads and mutations to a concrete company-local project or task boundary.
- Blocks direct edits to privileged agent configuration, company skills, and persistent instructions outside authenticated owner chat.
- Disables free-prose child-to-parent reporting comments so untrusted output is not promoted into higher-trust agent threads.

**Important for self-hosted deployments:** Clicking **Change `<agent>` to a low trust agent** in the setup wizard saves the `low_trust_review` policy preset only. It does **not** automatically provision a sandbox or configure a project trust boundary on self-hosted instances. Managed `low_trust_review` runs fail closed unless the agent's execution environment uses a `sandbox` driver and `isolated_workspace` mode, so configure sandbox isolation and project boundaries on your self-hosted runtime before reviewing untrusted external pull requests.

## 5. Localhost, self-hosted, and Cloud ingress plus bot branding

### Localhost and self-hosted via Paperclip Cloud connector (no ngrok or tunnels)

Local and private self-hosted instances do not need a public URL, reverse proxy, TLS certificate, or ngrok tunnel to run GitHub Review Bots:

- During setup, enrolling your instance with **Paperclip Cloud** routes GitHub callbacks and signed webhook deliveries through Cloud as a sealed transport gateway.
- Your local instance polls outbound to receive the sealed events, exchanges GitHub App registration codes locally, stores App credentials locally, verifies GitHub webhook signatures against the untouched request bytes, and enforces all repository and actor policies locally.
- On Paperclip Cloud managed stacks, ingress uses your stack's verified hostname automatically.

### Direct public HTTPS and existing-App recovery

If you operate a self-hosted instance on a public HTTPS domain and prefer direct delivery without the Cloud connector, Paperclip supports direct GitHub webhook ingress (`POST /api/chat-webhooks/:publicId/github`) and the expiring, single-use manifest callback (`GET /api/chat-github/manifest/callback`), verifying raw webhook signatures on every request.

If you already created a GitHub App manually—or need to recover or rotate credentials—select **I already have an App** (or **Use existing App credentials** on recovery) and provide the requested credentials. Connecting an existing App for the first time requires the App ID, PEM private key, and webhook secret; the webhook secret must match the value configured in GitHub App settings. If an unconsumed Cloud registration handoff expires before you create the App on GitHub, you can check **I haven't created this App on GitHub** and restart registration inside the same draft.

### Runtime prerequisites

The GitHub Review Bot connector uses your agent's existing Paperclip runtime and does not install new model or harness packages into your server image:

- Codex with managed MCP tools and the native Runner Codex backend do not require a server-side remote provider pack.
- Remote native ACPX (including Claude Code) and OpenCode currently require an operator-supplied, build-owned provider pack configured through `PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH` on self-hosted instances (the standard Cloud server image does not supply one, and a pack installed only inside the sandbox does not satisfy this requirement).

Run a quick test PR or `@mention` after setup to verify that your chosen harness and provider execute cleanly in the selected environment.

### Bot avatar and renaming the GitHub App

GitHub's App Manifest API does not accept an avatar image during App creation, so bot logos are uploaded in GitHub's App settings after the App is created:

1. In Paperclip, open the connected confirmation modal or expand **GitHub App name and logo** in the bot's **Settings** (or use the avatar download and **Edit App** controls in the bot header).
2. Download your Paperclip agent's avatar PNG.
3. Click **Edit on GitHub** to open the App's **Display information** page on GitHub and upload the PNG under **Display information**.
4. If you also rename the App on GitHub, its slug and `@mention` change. Return to Paperclip and click **Reconnect afterward** (or the refresh icon in the bot header) to sync the verified identity from the App's stored credentials.

## 6. Troubleshooting and publication recovery

- **Setup is waiting for webhook verification:** GitHub delivers the initial signed ping separately from your browser redirect. Keep the setup page open for a few seconds so Paperclip can drain the queued ping and verify its signature; closing the tab pauses readiness checks until you resume the draft.
- **A review timed out or hit a GitHub rate limit:** Paperclip saves the assessment and publication intent before writing to GitHub. GitHub bot tools use a 60-second default deadline and retry transient network errors, HTTP `408`/`429`, and GitHub server errors through a durable outbox (respecting `Retry-After` and rate-limit reset headers, up to eight durable attempts across restarts). App-owned comment markers and check identities recover lost responses without duplicating comments or checks.
- **Check shows `Action required` (`Authorized manual review required`):** The branch requires `Paperclip Review`, but automatic runs are disabled or filtered out for that PR author or event. Have an authorized linked member or sponsored contributor comment `@app-slug` on the PR to start the review.
- **Bot tools disabled on an older connection:** Open **Access** and click **Enable bot tools** to repair the connection explicitly without silently altering other permissions.
- **Bot does not respond to an `@mention`:** Confirm that (1) the repository is installed on the GitHub App **and** enabled in **Access → Repositories**, (2) the commenter is an allowed linked member or sponsored external contributor in **Access → People**, and (3) the message explicitly mentions `@app-slug` without the `[bot]` suffix (messages leading with another bot's mention do not wake your bot unless your bot is also explicitly mentioned).
