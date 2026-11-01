# Coordinating a test-gardening campaign

Use this guide for a broad sweep or multiple PRs. Apply the decision and
preservation rules in [SKILL.md](SKILL.md) to every batch.

## 1. Define the audit boundary

From the request, establish scope, desired benefit, time budget, target branch,
and delivery authority. Pin the base revision and inspect CI routing and cost
data, including setup/import overhead. Choose one mode:

- **Targeted sweep:** investigate promising owners or expensive repeated work.
  Report the examined area and exclusions; do not claim subsystem completeness.
- **Exhaustive audit:** inventory every in-scope test file and scenario, including
  colocated, shared-package, browser, and dedicated-lane coverage. Assign each to
  one owner and record its baseline as passed, failed, blocked, or unrun.

For an exhaustive claim, every declaration needs a decision and evidence;
classify table rows separately when their contracts differ. Missing baseline
results or unread tests leave the audit partial. Existing matching-revision CI
can supply results; a targeted sweep does not require a full-repository census.
Reserve time for preservation checks and reporting; an unfinished validation
leaves an unvalidated local patch, not a PR-ready result.

## 2. Assign owners and record decisions

Split work by protected production behavior, including tests across directories.
When delegation is authorized, assign each worker an isolated checkout, owner,
prior findings, model if specified, and discovery/edit/publication authority.
Tell workers to preserve others' changes. One coordinator owns shared fixtures,
routing, and integration. Do not edit a checkout with active test runs.

Keep one ledger in the task: candidate, contract,
retain/repair/consolidate/delete/defer, reason, keeper, baseline, validation, and
branch/PR status. Record reviewed areas with no safe removals too. Discovery
stays read-only until ownership is clear; qualified edits need no additional
user-approval round within existing authority.

## 3. Plan removal of redundant layers

Before editing a broad batch, review the ledger a second time by contract and
boundary. Look for suites that replay the same behavior through wrappers,
mocked collaborators, or provider-specific copies of a shared implementation.
Individual cases can look reasonable while the entire layer is redundant.

Record a compact layer plan in the task: retired suites, retained owner per
contract, unique assertions to transfer, affected routing/commands, validation
controls, and any unused fixtures or production seams. Prefer a boundary that
reaches the responsible code; preserve distinct transport, lifecycle, and
permission risks. If no whole layer qualifies, record that and proceed with justified
case-level changes. Large deletions are not a requirement.

The coordinator reconciles keeper dependencies across all batches before
cutover. Follow each chain to surviving proof; reject cycles and recheck keepers
another batch modifies or excludes from routing. A batch is ready when every
retired contract has retained proof or retirement evidence. Production-seam
removal still needs separate caller evidence.

## 4. Cut over and verify preservation

Move unique assertions first, apply one coherent batch, and update selection
and ownership references. Follow [validation.md](references/validation.md) for
baselines, controls, restoration, and cost claims. Serialize heavy database or
process runs when host capacity is shared; clean up only owned resources.

Review the combined diff against the layer plan. For broad or consequential
batches, use independent preservation review when delegation is available and
authorized; otherwise disclose that limitation. Resolve each finding with
source evidence or restored coverage and validate repaired assertions with an
intended-failure control. No batch is complete with an unresolved coverage gap.

An exhaustive audit requires a decision for every declaration, a completed and
classified baseline for every file, and passing preservation proof for each
removal. Diagnosed pre-existing defects may remain as explicit follow-ups;
unresolved setup failures or unread tests leave the audit partial. If time
expires first, report the remaining inventory and validation status.

## 5. Deliver and integrate

Prefer a few coherent PRs to one PR per trivial deletion. For a stack, record
each PR's head SHA, base branch/SHA, unique diff, and intended final target.
After a parent is squash-merged, discover its actual merge SHA and replay only
the child's unique change if necessary. Inspect the resulting PR diff for
accidentally reintroduced parent commits or files.

Resolve integration conflicts by reading new contracts on the target branch.
If a deleted file gained a regression, preserve that regression at an appropriate
owner; do not blindly accept the deletion or restore the entire old suite.

For authorized merges, use checks and reviews tied to the current PR head,
inspect unresolved findings, and respect the repository's merge policy. A
previous green head does not validate a changed head.

A PR marked “merged” into an intermediate stack branch is not necessarily
landed in the intended integration branch. Verify the full parent chain and
final diff inclusion before reporting the campaign landed. Preserve or clean
up branches/worktrees according to the user's instructions and retain needed
evidence before cleanup. Report delivery separately from audit completeness;
stop new discovery when the user asks to wrap up.
