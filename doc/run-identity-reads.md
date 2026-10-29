# Run identity reads

`captureRunIdentity` locks the task before the run. It validates company, agent,
and active status. Pending steering still requires its durable acknowledgement.
The accepted requester is read for each operation. No scope adds a cache or skips
these checks.

Callers choose a typed read scope:

| Scope | Retained run data | Consumers |
| --- | --- | --- |
| `identity` | Run and accepted requester identifiers, status | Gateway, native connection tools, connection intents, project skill setup |
| `task_authorization` | Identity, task bindings, wake request, conversation generation, skill-test marker | Projects, workspace repositories, Slack, voice, connection management |
| `token_broker` | Identity, invocation source, task/project/routine and requester attribution | Connection token broker |
| `project_execution` | Task authorization plus runtime mode and the complete saved native execution input | Muse project admission |

Narrow return types omit unselected columns. JSON projections preserve the types
of retained values. The default full read remains available for compatibility and
explicit inspection. Existing GitHub-credential and request-authentication scopes
keep their current contracts. Execution preparation and recovery retain their
separate complete-input reads.

The synthetic real-PostgreSQL benchmark captures the actual locked query and
compares every retained column, context and identity result. It keeps the same
five-query reconciliation transaction, checks the unchanged stored run, records
plans and alternating timings, and measures raw PostgreSQL DataRow bytes:

```sh
pnpm --filter @paperclipai/server exec tsx ../scripts/benchmark-run-identity-projections.ts --baseline-ref=623f1dc289a14a699ebbe3f09b94179d38fc2ae2
```

The default uses disposable embedded PostgreSQL. `PAPERCLIP_TEST_DATABASE_URL`
can select a disposable local database whose name ends in `_test`. DataRow bytes
exclude response metadata, TLS and TCP. Byte reduction does not establish a
production latency or billing change.
