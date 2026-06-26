# Dynamic Secrets Operator Guide

Dynamic secrets are experimental command-backed secrets. They let an operator
store a generator definition instead of storing secret material. At runtime,
Paperclip runs the generator on the host and injects the generated value into the
target environment.

This guide is about safe generator authoring. Paperclip can enforce the runtime
contract described here, but it does not certify that a generator is safe or that
the token it mints has the right privileges. The operator owns that trust
decision.

## Runtime Contract

A dynamic secret uses `managedMode: "dynamic_command"` and provider
`host_command`. It is available only when the `enableDynamicSecrets`
experimental setting is enabled.

The shipped runtime behavior is:

- The generator command is stored on the secret as a single executable path or
  command string.
- Static positional arguments are stored on each secret binding. Agents cannot
  provide or alter these arguments at runtime.
- Paperclip invokes the generator with `spawn(command, staticArgv, { shell:
  false })`. There is no shell interpolation, and stdin is ignored.
- The generator inherits the Paperclip server process environment.
- `stdout` is the generated secret value. Paperclip trims surrounding whitespace
  from stdout before injection.
- `stderr` is not returned to the agent or board UI. It only affects the failure
  message by indicating that host logs may contain details.
- Exit code `0` with non-empty stdout succeeds.
- Missing command, non-zero exit, signal termination, timeout, or empty stdout
  fails closed with no value injected.
- The default timeout is 30 seconds. `PAPERCLIP_DYNAMIC_SECRET_COMMAND_TIMEOUT_MS`
  can lower it or set another positive value up to that 30 second ceiling.
- Successful generated values are cached by binding and static argv for the
  secret's configured TTL. During that TTL, Paperclip injects the cached value
  instead of re-running the generator.

Dry runs from the board UI use the same command contract, but return only a
pass/fail result plus non-sensitive metadata such as byte length. They never
return the generated value.

## Safety Practices

Treat the generator as privileged host-side code.

- Keep the root credential on the host side, outside Paperclip agent workspaces
  and outside agent-readable configuration.
- Prefer a dedicated helper binary or script with a narrow interface over a
  general-purpose shell wrapper.
- Mint the narrowest token possible for the specific binding. Use static argv
  for operator-controlled selectors such as organization, repository, account,
  role, or installation id.
- Make the minted token short-lived. Avoid long-lived bearer tokens when the
  upstream service supports scoped temporary credentials.
- Never print the root secret, refresh token, private key, or credential source.
  Print only the derived runtime token to stdout.
- Keep stderr non-sensitive. Stderr may be referenced in host logs during
  debugging.
- Make generators idempotent and side-effect-light. A generator may be retried
  after a timeout or process failure, and a failed injection should not leave
  durable external state behind.
- Fail with a non-zero exit when the generated credential would be missing,
  over-broad, expired, or otherwise unsafe.
- Avoid reading mutable input from the agent workspace. Runtime arguments are
  already fixed by the operator on the binding.
- Run the board UI dry-run after authoring or changing a generator, then verify
  the target workflow with the least-privilege binding you expect agents to use.

## Trust Posture

Dynamic secrets reduce storage of long-lived secret material in Paperclip, but
they do not automatically create a hard isolation boundary.

Under the current local/default posture, dynamic generators are a soft boundary.
The generator runs as the same operating-system user as the Paperclip server,
similar to the `local_encrypted` provider posture. A same-UID agent or process
with enough local access can potentially observe process state, host files, or
runtime values. Use this posture for trusted local operation, not as containment
against a hostile same-UID agent.

A hard boundary requires an approved sandbox or environment driver that isolates
the generator and injected value from the host and from untrusted agent code.
Do not describe a deployment as hard-isolated just because it uses dynamic
secrets.

## TTL Guidance

TTL controls Paperclip's successful-value cache. It should be no longer than the
usable lifetime of the minted token and usually shorter.

Choose a TTL by balancing freshness and upstream rate limits:

- For tokens valid for minutes, use a TTL of seconds to a few minutes.
- For tokens valid for about one hour, a TTL around 5 to 15 minutes is a common
  starting point.
- Lower the TTL when revocation speed or least privilege matters more than API
  rate limits.
- Raise the TTL only when the generator is expensive or the upstream service has
  tight token-minting limits.
- Do not set the TTL equal to or beyond the upstream token expiry. Clock skew,
  queued runs, and retry timing can otherwise inject a nearly expired token.

## Worked Example: GitHub App Installation Token

Goal: let an agent push to one repository without giving it the GitHub App
private key.

Host setup:

- Store the GitHub App private key outside the repo and outside agent
  workspaces, for example under a root- or operator-owned secrets directory.
- Install a small generator at an absolute path such as
  `/usr/local/bin/paperclip-mint-github-installation-token`.
- Make the generator accept only operator-fixed static argv such as:
  `["--installation-id", "123456", "--repository", "owner/repo"]`.
- The generator authenticates as the GitHub App, requests an installation access
  token scoped to that repository and only the permissions needed for the task,
  prints the token to stdout, and exits `0`.
- On any API, key, permission, or repository mismatch, the generator prints no
  token and exits non-zero.

Paperclip setup:

- Create a dynamic secret with command
  `/usr/local/bin/paperclip-mint-github-installation-token`.
- Set the binding static argv for the target agent, project, or routine to the
  installation id and repository it may access.
- Set TTL lower than the GitHub installation token lifetime. For a one-hour
  GitHub App installation token, start around 600 seconds and adjust for rate
  limits and run frequency.
- Run the board UI generator test before saving, then run a task that needs only
  that repository permission.

The agent receives only the installation token selected for that binding. It
does not receive the GitHub App private key and cannot choose a different
installation or repository unless the operator changes the binding argv.
