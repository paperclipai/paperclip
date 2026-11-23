# Company UI test consolidation proof

Proof base: PR #16111 exact head `06c1b2035df44fa03c065ddd69e8bf8df8513b86`. Proof used GPT-6.1-Sol. The changes affect only test files.

| Owner | Original | Candidate | Full original-file restore | Candidate restored |
|---|---:|---:|---:|---:|
| `ui/src/pages/CompanyImport.test.tsx` | 29/29 | 28/28 | 29/29 | 28/28 |
| `ui/src/pages/CompanyEnvironments.test.tsx` | 32/32 | 31/31 | 32/32 | 31/31 |

All complete-owner runs exited 0, with no failures or skips. Both production mutations below exited 1 with exactly one failure in the keeper. The mutated production files were restored byte for byte before the final candidate runs. The reduction removes 2 test registrations and 15 net test lines. The isolated runs were about 7 seconds and 4 seconds per owner; this is not a CI timing claim.

## Reproduce

Use a clean checkout at the proof base with dependencies installed. Run commands from the repository root.

```sh
pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyImport.test.tsx --maxWorkers=1
pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyEnvironments.test.tsx --maxWorkers=1
```

Expected original counts: 29 and 32 passing tests. Apply the PR's two test-file changes and rerun the same commands: 28 and 31 passing tests. Restore both complete original test files from the proof-base commit and rerun: 29 and 32 passing. Reapply the candidate changes and rerun: 28 and 31 passing.

## Production mutation controls

For CompanyImport, apply the candidate test change, then in `ui/src/pages/CompanyImport.tsx` replace the success-path invalidation below:

```ts
await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
```

with:

```ts
await queryClient.invalidateQueries({ queryKey: ["audit-unrelated-company-query"] });
```

Run only the keeper:

```sh
pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyImport.test.tsx --maxWorkers=1 -t 'submits the import as an async job, then activates selected agents and routines'
```

Expected result: exit 1 at the `invalidateQueries` query-key assertion. The control observed the unrelated key in the real QueryClient call. Restore `CompanyImport.tsx` from the proof-base commit and verify its SHA-256 is `872d67109ab968fada24f126ad92974c5d060f7552dc4e8299a6185d2b87fe6c`.

For CompanyEnvironments, apply the candidate test change, then in `ui/src/pages/CompanyEnvironments.tsx` replace the Local option:

```tsx
<option value="">Local</option>
```

with:

```tsx
null
```

Run only the keeper:

```sh
pnpm --filter @paperclipai/ui exec vitest run src/pages/CompanyEnvironments.test.tsx --maxWorkers=1 -t 'opens the add-environment form on a standalone page and closes it on cancel'
```

Expected result: exit 1 at the migrated `Local` option assertion. Restore `CompanyEnvironments.tsx` from the proof-base commit and verify its SHA-256 is `871d93af7394090ccdb6ffaaa518c7462055ffb75766e6b9736afdd34e18884b`.

After both restores, rerun the complete candidate-owner commands. They must pass 28/28 and 31/31. Keep the candidate changes in the two test files; do not leave either production mutation applied.

## Retained behavior

CompanyImport retains the full async import and activation assertions. The keeper adds a QueryClient invalidation spy and confirms the companies list is invalidated before activation. Its `finally` path restores the spy.

CompanyEnvironments moves the implicit Local-option assertion into the existing add-environment scenario after the same initial render and React flush, before opening Add. The same scenario retains the form and cancel assertions.

The proof also checked that retained test names, fixtures, provider state, actions, hooks, and assertions were unchanged beyond these migrations. There are no skips or production changes in this pull request.
