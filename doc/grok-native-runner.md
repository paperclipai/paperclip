# Grok Build native runner

Select **Grok Build** in the native runner provider selector. The stored contract is
`adapterType: "paperclip_runner"` with `provider: "acpx"`, `acpxAgent: "grok"`,
and `model: "grok-4.7"`. Existing `grok_local` agents keep their legacy adapter.

Grok Build speaks [ACP over stdio](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md).
The runner owns `grok agent --no-leader stdio` through ACPX, including session
identity, cancellation, recovery and the authenticated Paperclip MCP bridge.
It does not add `--always-approve`. Restricted operations use the selected ACPX
permission policy and return the existing approval-required outcome. Isolated ask
rules override project allow rules, and compatible always-approve settings are
locked off. Compatible hook/MCP discovery and shell login capture are disabled.

## Installation and identity

Run `pnpm --filter @paperclipai/paperclip-runner install:grok` after installing
workspace dependencies. This explicitly downloads Grok Build 1.0.13, verifies
the native executable digest in `packages/grok-acp/platforms.json`, and installs
it privately. Only macOS arm64 and Linux x64 are admitted. Provider packs install
the same verified binary. No ambient `grok` from PATH is used by the native runner.
ACP must report the requested exact model; absent or mismatched identities fail.

Instructions use Grok ACP session rules. Assigned skills live in the isolated
Grok home. Steering and goals are unsupported. Token and cost values remain
unknown when Grok does not report them; missing usage is not zero usage.

## Authentication

Use the existing Grok company connection/login flow for subscription execution.
An explicitly selected company-secret `XAI_API_KEY` selects paid API execution.
There is no automatic subscription-to-API fallback. Remote execution cannot
borrow the operator's home credentials. Local execution can use the operator's
existing Grok login when no company login has been selected.

Only the selected credential is staged in the private runtime home. An ownership
lease fences concurrent processes. Before ACP startup, an expiring subscription
credential is refreshed through the verified Grok executable’s non-inference
`models` command. This bounded step suppresses output and prevents Grok 1.0.13
from caching a pre-refresh model list. Exact model verification still precedes
any prompt; refresh failure requires reconnecting Grok Build. After the provider exits, refreshed credentials
are copied back through Grok's existing identity and refresh checks. Runtime
credentials, refresh handoffs, and diagnostic logs are excluded from workspace
backups and removed on close. Session history remains available for resume. Host
configuration, other provider credentials and unselected keys are not forwarded
to Grok.

## Evaluation

The private `paperclip-evals` repository maintains `live-acpx-grok-4.7.json` and
`rosters/live-acpx-grok.json`. The roster covers all 39 protocol cases. Its campaign
lane remains disabled pending complete live qualification.

Product E2E exposes `runner-acpx-grok` in core local/Daytona compatibility and
local session integrity. The explicit `grok-qualification` suite covers replies,
planning approvals, structured questions, downloadable project revisions, stop/resume
and continuation after controller restart
in both environments. Run with `--suite grok-qualification`; it is excluded from
scheduled `--all`. Use the canonical Product E2E dashboard and Evalbook reports.

The separate `grok-subscription-qualification` suite covers the same workflows
with the explicit `GROK_AUTH_JSON` fixture credential. It seeds only the disposable
company's private login home and supplies no API key. It does not exercise the
interactive sign-in UI. Authentication mode remains part of the profile identity.
After a subscription upgrade, a fresh `grok login` may be needed if the existing
login still reports the previous entitlement through ACP.

`packages/paperclip-runner/scripts/grok-native-smoke.mjs` records explicit auth,
model/binary identity, MCP outcome, durable resume and restrictive permissions.
Pass `--auth subscription --auth-file /private/path/auth.json --output /private/report.json`
or `--auth api --output /private/report.json` with an explicitly supplied key.
Each attempt is retained; unknown usage and cost are null.

Qualification requires the full protocol roster, selected product workflows,
subscription and API execution locally and on Daytona, and three successful
repetitions of core tool, approval and resume cases. Deterministic tests or a
single successful browser task do not establish that qualification.

## Remote verification

Do not run Docker on a developer laptop when using remote verification. The
`Docker Runner check` workflow offers maintainer-authorized manual EC2 image
builds and broad source checks without provider credentials. It records the
source revision, resolved lock digest and immutable image reference. Paid
Product E2E remains behind the protected default-branch workflow and environment.
