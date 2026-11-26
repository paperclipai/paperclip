# Preservation, cost, and evidence

## Prove the retained behavior

Pin baseline and candidate revisions and record the actual command, project,
filters, environment differences, and pass/fail/skip counts. Prefer focused
owner and affected sibling runs. A zero-test run, setup error, or fully skipped
suite is not a successful baseline. Use recent CI only when its revision and
test selection support the claim being made.

For straightforward exact duplicates, compare all assertions, fixtures,
configuration, and selection. For assertion migration, weaker-to-stronger
coverage substitution, security/persistence boundaries, or uncertain failure
sensitivity, use a deliberate control:

1. Run the keeper normally and observe it passing.
2. In an isolated, idle checkout, temporarily introduce the specific plausible
   production regression the keeper is meant to detect, or revert the relevant
   fix. Keep unrelated guards and fixtures valid.
3. Verify the expected case fails at the intended assertion. A timeout, missing
   dependency, unrelated rejection, or initialization failure is not proof.
4. Restore the exact pre-control bytes in a guaranteed cleanup step. Check the
   diff/hash and run the same selected case successfully again.
5. Run the affected candidate owners without that narrow name filter before
   calling the complete owner suite green.

Never mutate a checkout with active tests, commit a temporary mutation, or
overwrite someone else's source changes during restoration. Do not add a
permanent replacement test solely to justify removing an obvious duplicate.

## Verify what actually runs

Inspect the real runner entry point, include/exclude rules, package projects,
shard routing, dedicated CI lanes, and documented focused commands. A test
existing on disk does not guarantee that it executes in the required run.
The required invocations are the affected CI lanes and supported developer
commands for the audit's scope. Redirecting a documented alias command to its
owner is valid when the configuration and protected contracts remain equivalent;
preservation does not require retaining an obsolete filename indefinitely.

When removing test-import aliases, prove that the retained owners remain
selected with the intended multiplicity in each required invocation. Update
explicit commands and ownership inventories. Use dry-run routing to inspect
selection and an actual focused run to confirm execution where import caching
or collector behavior makes listing ambiguous. Intentional runs on different
platforms/configurations are separate contracts, not duplicate registrations.

## Measure the benefit honestly

Keep these quantities separate:

| Quantity | Interpretation |
| --- | --- |
| Deleted source declarations / expanded table cases | Change in test code or case inventory. |
| Avoided registrations / suite invocations | Repeated execution eliminated; may remove no unique contract. |
| Test/support LOC | Maintenance reduction, not a runtime estimate. Report additions and net change. |
| Production LOC | Runtime code changed, with its own justification; do not combine it with test LOC. |
| Historical manifest weight | Scheduling estimate at its recorded revision/date, often including setup/import cost. |
| Case time / owner suite time / process time | Different scopes; compare like with like. |
| Shard time / workflow critical path | Scheduling and parallelism effects; summing suite savings does not predict elapsed CI savings. |

Use bounded matched baseline/candidate runs when a quantified runtime claim is
important. Keep environment and configuration comparable, alternate order when
practical, and disclose sample count and variation. Inspect neighboring suites
for host-wide drift. A faster unrelated shard is not deletion evidence; a slower
whole suite does not establish that removing a duplicate caused a regression.

Logs that only print slow cases provide censored observations: an absent case
is below the reporting threshold, not zero milliseconds. A passing retry is
validation evidence, not a fair speed comparison with the failed attempt.
Report uncertain speed effects as inconclusive and keep structural benefits
separate. Do not demand significance testing for every safe maintenance edit.

## Failures and durable reporting

Classify failures before acting: product assertion, test defect, setup/dependency,
host capacity, or CI infrastructure. Fix relevant defects or report the blocker;
do not weaken assertions, increase budgets, skip suites, or erase a failing
baseline to obtain a green audit. Retry a demonstrated transient problem within
a stated bound; a recurring failure needs investigation.

Use concise task and PR notes for revisions, decisions, keepers, commands,
results, controls, measurements, and limitations. Keep campaign ledgers and
plans in the task too; do not commit audit documentation or receipts to the
repository. Documentation changes require an explicit human request. Link
accessible CI runs/artifacts when they support claims. Temporary paths and
hashes alone do not make evidence durably inspectable. Do not generate large
evidence dossiers for trivial deletions or store raw logs containing secrets.
State precisely which broad checks remain unrun.
