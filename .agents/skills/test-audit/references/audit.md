# Candidate evidence and retention

Use this reference before deleting or consolidating tests.

## Search for waste, then inspect the contract

| Candidate pattern | What to establish before changing it |
| --- | --- |
| Several tests repeat one assertion through the same production path | A retained case has equivalent inputs, failure sensitivity, and relevant setup. |
| A test file only imports another test file | The real owner is selected in the same required runs; the alias adds no setup, configuration, or separate entry point. Check both CI and documented commands. |
| A large table repeats equivalent rows | Preserve rows that exercise different branches, boundary values, error classes, platforms, or defaults. |
| A bulk fixture creates many interchangeable records | Establish that the count does not cross batching, pagination, concurrency, or transaction thresholds. Retain mixed outcomes and persisted state assertions. |
| Assertions copy lists, exports, strings, or source shapes | Determine whether the list or shape is an independent public, packaging, generated, or architecture contract. |
| Mocks implement the behavior being asserted | Find a test that exercises the responsible production behavior; otherwise repair or relocate this proof before removing it. |
| Fixtures fabricate receipts, ordering, or persisted state | Verify that the responsible production path creates that evidence; fixture-supplied outcomes cannot prove it does. |
| A negative case passes for an unrelated reason | Reach the named guard with otherwise valid inputs. Fix useful coverage rather than discarding it as waste. |
| A test-only export, reset hook, or wrapper becomes unused | Search runtime callers, package exports, generated callers, supported integrations, and history. File location alone does not make it dead production code. |

Also inspect self-comparisons, assertions with expected values derived from the
subject, probes with no checks, and names that promise more than the body tests.
Explicitly assertion-free smoke tests can still protect module loading or
execution; identify that purpose before deleting them.

## Reasons to retain apparently similar tests

Two tests can use the same payload while protecting different failure modes:

- Authorization and tenant isolation at separate exposed entry points.
- Direct API versus SDK/MCP transport, including serialization and errors.
- Initial execution versus replay, recovery, restart, or concurrent access.
- In-memory return values versus committed database state or rollback.
- Default-off behavior versus explicit opt-in; missing versus invalid input.
- Platform behavior, published package exports, migrations, generated-language
  compatibility, or intentional prompt/protocol bytes.
- Browser interaction, reconnect, pagination, lost responses, attachment
  persistence, or visible ordering absent from lower-level coverage.

Keep a static check when it is an independent and appropriate guard of a
contract. Implementation-shaped checks that fail on a harmless identifier
rename deserve scrutiny; this does not make all source inspection disposable.
Likewise, a slow integration test can be the only meaningful proof of a
transaction or lifecycle. Cost helps rank investigation, not determine truth.

## Evidence before editing

Read the candidate's full body and parameter rows, setup/teardown, production
owner, real callers, proposed keeper, configuration, and relevant history.
Look for why the test was introduced and regressions added since. Inspect the
dependency's actual contract when a claim depends on library behavior.

Use a compact table or PR notes:

| Candidate | Decision and reason | Contract/regression | Keeper or retirement evidence | Validation and benefit |
| --- | --- | --- | --- | --- |
| File and case/rows | Retain / repair / consolidate / delete / defer | Observable failure detected | Exact file/case, or evidence the contract no longer exists | Commands/control, cost or maintenance reduction, limitations |

For consolidation, list unique assertions to move. The keeper must actually
exercise them with valid fixtures; adding an assertion that cannot fail is
not coverage preservation. If setup or the selected test project differs,
explain why it does not change the protected contract.

## Two useful distinctions

- An import-only alias and its directly selected owner may duplicate execution.
  An identical-looking alias importing a package suite absent from the default
  run may be the only entry point and must stay until routing is repaired.
- Repeated successful records in a bulk route fixture may be reducible while
  retaining mixed failures and persisted outcomes. The same reduction would
  invalidate a test whose record count exercises a batch or pagination limit.

If evidence is missing, defer that candidate and keep working on independent
ones. Audit-only findings do not become permission to delete tests elsewhere.
