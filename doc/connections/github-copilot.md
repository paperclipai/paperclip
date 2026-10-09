# GitHub Copilot runtime connection

The current candidate uses the pinned Copilot CLI **1.0.88** and Paperclip Runner
profile **v36**. This profile is undergoing a frozen local/Daytona qualification
campaign. Historical passes apply to their recorded builds. Current-head CI,
review, all required live cases, and ordinary installed canaries must pass
before rollout.

On first setup, choose **GitHub Copilot** when creating your first agent. In an
existing organization, open **Connectors → GitHub → Connect Copilot**. Create a
fine-grained personal access token owned by your personal GitHub account and
add the **Copilot Requests** account permission. Organization-owned tokens and
classic personal tokens are unsupported for this setup. Follow
[GitHub's authentication instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli).

Save the token as a personal or shared AI connection and select the execution
environment. Paperclip uses its encrypted credential store, grants, access
checks, reconnect/revocation, and activity logging. GitHub repository/MCP access
uses its separate connection and grants. Copilot execution receives only the
selected runtime token as `COPILOT_GITHUB_TOKEN`; ambient GitHub credentials
are not adopted.

Connection verification runs the pinned packaged runtime in the selected
environment with a private temporary home. It initializes a session, discovers
models, and confirms an explicitly selected model when testing an agent. It
sends no model prompt. Authentication, entitlement/policy, installation, and
unavailable-model errors are reported separately. Remote verification releases
its owned login lease and does not fall back to the controller host.

In an agent's **Harness / Runtime** settings, select **Paperclip Runner**,
**ACP agents**, **GitHub Copilot**, and a model from authenticated discovery.
Saving and reopening retain `provider: acpx`, `acpxAgent: copilot`, and that exact
model. Auto/default and unavailable models are rejected. The qualification
model is `gpt-5.6-luna`, subject to current authenticated availability.

Normal package installation materializes the pinned runtime for macOS ARM64,
macOS x64, and Linux x64. Keep installation scripts enabled. No qualification
environment override or ambient GitHub login is required. **Test configuration**
verifies the saved connection and exact model without sending a prompt.

For Daytona, install the first-party Daytona provider and configure an execution
environment with its saved API key and the matching release image. Environment
assignment currently uses Paperclip's existing **Enable Environments** instance
setting. Select that environment for connection verification and agent execution;
successful local verification alone does not establish remote readiness. The
admitted daemon and provider assets must belong to the same verified build.

Core workflows use Paperclip's semantic questions, plans, and completion tools.
Permission cards identify actual targets. Denied writes have no effects; Stop
cancels unanswered permissions and refuses late answers. Provider death must
expire stale input without replay. Detached work, native steering, native plan
mode, and additional native event presentation are outside this release.
Unsupported native blocking callbacks fail explicitly.

Usage is attributed to **GitHub**. Provider credits and model multipliers are
supplemental notices, not USD billing receipts. USD cost remains unknown when
GitHub supplies no invoice value; included credits are not recorded as measured
zero-dollar usage. Session-scoped notices cannot establish task completion,
artifacts, or charges.
