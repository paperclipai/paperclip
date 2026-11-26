# Round 10 database schema test audit

This test-only change is stacked on #16075 at `3432307f95f679e20b991c6a250934c2114b7aaf`. The original matched baseline and control ran on its prior head `e86a747fc028069d2bb4d699bd814e0d82fad558`. The parent correction changes documentation only; the rebased complete owner replay passed 6/6 with no failures or skips. It removes one registered case and six net test lines. It makes no measured CI time claim.

| Retired case | Keeper | Preserved observations |
| --- | --- | --- |
| `keeps the owner principal non-null and drops the environment from the key` | `serializes the active slot on company, owner, and adapter` | Copy the exact `started_by_user_id` non-null assertion. The keeper's exact index column list already proves that the owner is present and the environment is absent. |

Both cases inspect the same `adapterAuthSessions` table and active index. The keeper still checks index presence, uniqueness, the exact company/owner/adapter columns, and the partial predicate. The public-session identity, claim marker, active states, secret-column exclusion, and migration SQL cases remain separate. No fixture, helper, schema, migration, or caller changes.

The direct owner is `packages/db/src/schema/adapter_auth_sessions.ts`. Its owner column prevents a null principal from escaping the active unique index. Local login, device login, and setup-token services use this company/owner/adapter scope. The DB project runs in the default `general-workspaces-c` CI group.

Complete-file command:

```sh
pnpm exec vitest run packages/db/src/adapter-auth-sessions-schema.test.ts
```

| Run on the exact stacked base | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Baseline | 7 | 0 | 0 |
| Candidate | 6 | 0 | 0 |
| Nullability control | 5 | 1 | 0 |
| Restored-owner candidate | 6 | 0 | 0 |

The deliberate control removes only `.notNull()` from `startedByUserId` in the production schema. The complete file fails only the keeper at the copied non-null assertion (`false` instead of `true`). The other five cases pass. Restore the schema before the positive replay.

A whole-program byte comparison proves that the only test changes are one retired statement and one exact copied assertion. Production schema bytes are restored with SHA-256 `ada8f01da2171306b97e5cb2b14b52dd53f6a7d58dd9dd51414d381c56821235`. Candidate test SHA-256 is `9719104e3f6d79d868dee36b1778ce758da8829ffc4485019cad41a128bcff6f`. The earlier independent proof at `77408fa6c3d7c916d7160760eae2144aaa0f8fe7` is preserved separately. Root review approved the keeper map before this PR.

Risk: the index keeper now reports both index and owner-nullability defects. An earlier index failure can stop the later assertion, but still fails the scenario. Each distinct schema and migration contract remains covered.
