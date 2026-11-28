# Deployment-configured harness availability

Core owns the mechanism for filtering harness choices. The deployment owns
the policy. Do not add a built-in Cloud provider allowlist to Core; change the
deployment's environment configuration when its supported harnesses change.

Managed deployments can set `PAPERCLIP_AVAILABLE_HARNESSES` to a JSON array of
canonical harness IDs, for example `["gemini_local"]`. The server publishes
the array as `cloud.availableHarnesses` on `/api/health`; every Cloud harness
selector uses that metadata. This includes creation and direct setup links,
agent configuration, issue and composer settings, bulk edits, imports, team
installs, and invites. Model catalogs for excluded harnesses are not fetched
by those controls.

- Unset: no additional deployment restriction. Existing adapter availability,
  feature flags, and qualification rules still apply.
- `[]`: no harness choices.
- Invalid JSON, non-array values, invalid IDs, more than 128 entries, or a
  value over 16 KiB: no choices, with a warning that omits the supplied value.
- IDs use lowercase letters, digits, `_`, `:`, and `-`, start with a letter,
  and are at most 128 characters. Duplicates are removed. Syntactically valid
  unknown IDs are accepted so configuration does not require a Core registry
  update; they do not install or enable an adapter.

IDs follow `agentRuntimeSettingsHarness` in
`packages/shared/src/agent-runner.ts`. Native Runner profiles map to
their underlying harness (for example ACP Copilot is `copilot_runtime`), so
allowing the Runner adapter alone cannot bypass a profile restriction.
Existing agents can retain their stored configuration; selectors and import
or install submissions cannot select an excluded profile.

Change the environment value and restart/redeploy the tenant server. The UI
uses the shared health cache; reload the page after rollout to fetch the new
policy. The parser also reflects changed values on subsequent health requests
in runtimes that update their environment in place. No UI build is needed.
Without managed Cloud metadata this setting has no effect.

This is a UI availability policy, not an execution authorization boundary.
It does not revoke credentials, stop existing agents, or qualify experimental
harnesses. Operators must deploy a Core revision that supports this contract
before relying on it; older revisions ignore the variable.
