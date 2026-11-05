# Fixed-command service processes

An administrator can pin the command of a `process` agent with `adapterConfig.fixedCommand: true`.
This mode requires saved `command`, `args` and `cwd` values. Do not use it for an agent that must
choose its own commands.

## Persistent key

The persistent agent key can read its own agent record and send an empty trigger to its own
agent (`wakeup` or `heartbeat/invoke`, body limited to `idempotencyKey`). The key cannot change
configuration and cannot read secret values. The response contains only status and the fixed
parameters that the wrapper needs to reconcile a trigger. It does not return environment values,
secret references or permissions.

## Environment

The environment is also pinned. Before secret resolution, the server compares the saved and the
effective variables, including secret references. It rejects extra variables from the issue,
project, routine or execution environment. The existing secret service resolves secret values.
The server then keeps an in-memory snapshot of the environment and checks it before dispatch. A
request cannot send or replace this snapshot. The controller adds the run scratch and GitHub
transport variables separately and takes a new snapshot before it gives the run to the adapter.
A change after the check is rejected. The child process gets only the approved environment and
server run data (`inheritEnv: false`). Other adapters and ordinary processes keep their existing
behavior.

## Secrets

Secret access stays with the temporary JWT of the active run and its existing secret binding.
The persistent key does not replace the JWT, and a finished run loses access. Secret values are
not written to configuration, logs or a snapshot on disk.

## Watchdog signals

An administrator can also set `watchdogService`: `assigneeAgentId`, a `signals` list with `type`
and `marker`, and an optional `legacyIssues` list. The server builds the context from the saved
configuration and the active run. A marker in text grants no access.

- New issues get a server-set origin.
- Reads and comments are allowed only on open issues of the configured company and assignee with
  a verified origin. The issue list also applies the caller's private-issue access.
- Legacy issues need an exact administrative pin of the issue ID, type and origin fields.
- The watchdog run can read only the secret that an administrator bound to the agent at `env.DOKPLOY_KEY`. Other bindings of the same agent do not extend this access.

The server checks the target again before it writes a comment. The existing per-run action limit
and the permit/deny audit log stay in place. A service comment is not a reviewer decision and
does not change issue fields. The agent itself, another agent or an agent-approved request cannot
change this configuration.

## Tests

Run `fixed-process-secret-http.test.ts`, `fixed-process-execution.test.ts`,
`fixed-process-configuration.test.ts` and `watchdog-service-request.test.ts` on an isolated
database before you enable this mode.
