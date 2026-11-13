# Native Runner integration working templates

Use these with the [Runner integration playbook](RUNNER-INTEGRATION-PLAYBOOK.md).
They cover adding a harness/provider to the **new, native Paperclip Runner**.
Legacy direct-adapter authoring and migration are outside scope; existing behavior
is preserved through compatibility checks. The templates require no historical
chat, private task, evidence archive, or separate private repository.
Copy only the sections needed for the current integration. Replace placeholders;
these are documentation templates, not executable schemas or proof of completion.
Repository plans belong in dated `doc/plans/YYYY-MM-DD-<harness>-integration.md`
files. A Paperclip issue's requested plan belongs in its plan document.

## 1. Release contract

```markdown
# <Harness> integration — <date>

Owner:
Source baseline / branch / prerequisite:
Requested finish line: <reviewable PR / merged experimental / staging / production>
Authorized actions and spending:

## User outcome

<The ordinary task, actual execution location, and inspectable result.>

## Scope

- Native Runner harness driver, provider translation, and transport:
- First acceptance environment:
- Supported OS/architectures and required proof level for each:
- Authentication/setup path:
- Runtime-auth versus repository/MCP connection method, ownership, and grants:
- Save/reopen/Test/reconnect/revoke proof and selected probe environment:
- Caller-selected model/mode policy:
- Acceptance model/reasoning/mode, separately from product policy:
- Required capabilities and applicable acceptance cell IDs:
- Deferred/unsupported capabilities and product treatment:
- Accounting requirements and unknowns:
- Campaign/account/key/infrastructure/review limits:
- Retry policy and cleanup obligations:
- Publication/deployment/merge authority:

## Architecture

- Provider-owned translation and launch code:
- Shared contracts that need a new provider-neutral capability:
- Instruction/tool/credential admission:
- Recovery identity and allowed refreshes:
- Cancellation and terminal settlement:
- Packaging and normal installation:
- Database constraints, migrations, and generated declaration/catalog sources:
- Clean PR-layer builds and normal local/remote artifact resolution:
- Existing native-provider and legacy-direct-adapter behavior preserved:

## Acceptance and delivery

<Link capability matrix, acceptance ledger, immutable evidence, operator recipe.>

## Scope changes

| Date | Decision and authority | New scope | Preserved exclusions/failures |
| --- | --- | --- | --- |
```

## 2. Capability inventory

Use one row per capability or meaningful field. “Implemented” and “qualified”
are separate columns. An absence claim needs evidence at the relevant layer.

| Capability/field | Exact harness/version/mode | Native evidence | Transport/wrapper | Runner mapping | Durable product/UI | Qualification | Loss/reason/next action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Example: active steering | `<version>` | `<method or observed absence>` | `<preserved/dropped>` | `<control mapping>` | `<visible action>` | `<attempt ID + environment>` | `<why unavailable or what remains>` |

Allowed evidence labels: documented; source-observed; credential-free observed;
authenticated observed; product-qualified; unverified; confirmed absent in the
specified implementation. Do not collapse them into a single supported flag.

## 3. Acceptance and attempt ledger

Keep one row per required cell, with every attempt linked. A pass on another
profile/environment is historical evidence, not this row's pass.

| Gate | Exact cell/environment | Required observation | Candidate identity | Attempts | Current verdict | Remaining action/owner |
| --- | --- | --- | --- | --- | --- | --- |
| Normal task delivery | `<catalog ID>` | `<native completion + task Done + verified download + cleanup>` | `<candidate record>` | `<failure 1, pass 2>` | `<pass/fail/unattempted/blocked>` | `<specific action>` |

Keep deferred capabilities in the release contract, outside the denominator.
Keep cleanup failures visible even when task assertions passed. Never calculate
the denominator by counting only attempted or successful cells.

Report totals explicitly: `<passed> passed, <failed> failed, <unattempted>
unattempted, <blocked> setup-blocked of <required>`. Record whether each failed
attempt reached its intended boundary; a startup failure did not exercise Stop.

Example candidate record:

```yaml
candidate: <stable campaign-local name>
application_commit: <40-character SHA>
runner_source_commit: <SHA if distinct>
shipping_source_dirty: false
profile_version: <value>
profile_digest: <digest>
provider_package_version: <name@version>
wrapper_and_patch_digests: <manifest reference>
dependency_lock_digest: <digest>
daemon_and_provider_pack_digests: <manifest reference>
public_package_digests: <manifest reference>
image_digest: <immutable digest or not-applicable>
environment: <local/SSH/Daytona + actual architecture>
platform_proof: <native-live/native-startup/emulated-startup/build-only>
model: <explicit exact ID>
mode_and_reasoning: <exact settings>
product_fixture_commit: <SHA>
protocol_case_revision: <repository-relative case files + commit/digest>
catalog_or_definition_digest: <digest>
grader_revision: <revision>
credentials: <binding identifiers only; never values>
spending_bound: <authorization + verified cap + remaining reservation>
shareable_evidence: <reviewer-accessible sanitized inputs, results, and reproduction steps>
sensitive_evidence_store: <restricted location if needed; not a prerequisite for understanding the claim>
durable_resume_record: <manifest, budget window/holds, active jobs, gates, cleanup; outside temporary storage>
published_review_head: <exact commit or unpublished>
shipping_base_and_dependencies: <base commit, PR ordering, required fixtures/installers>
```

## 4. Failure and retry decision

```markdown
### <Attempt ID> — <timestamp>

- User outcome and target boundary:
- Exact candidate / cell / environment:
- Expected observation:
- Actual observation and first divergence:
- Was the target boundary reached?
- Was required concurrency observed (pending input, attached child at finish)?
- Did the observer capture native order, or only delayed projection/persistence?
- Relevant native request/tool/turn identity (redacted where necessary):
- Original grade and retained evidence:
- Primary class: product / model-provider / grading-evidence / infrastructure
- Supported cause, confidence, and alternative explanations:
- Cleanup result and remaining resource obligations:
- Measured cost / estimate / unknown / budget reservation:

Correction:
<Owning boundary and smallest general change; no fixture-specific product hack.>

Cheap discriminating proof:
<Real dependency or controlled replay; positive and negative cases.>

Retry decision:
<Changed input, existing authority, selected cell, new attempt ID, budget.>

Evidence impact:
<Which previous results remain relevant; which require fresh measurement.>
```

## 5. Active work ledger

| Handle | Kind | Owner | Candidate/cell | Started | Next useful observation/deadline | Budget reserved | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<actual job/process ID>` | `<build/cell/review>` | `<owner>` | `<identity>` | `<time>` | `<expected state>` | `<amount/unknown>` | `<required action>` |

After compaction, inspect actual handles and persisted state before restarting.
Record superseded jobs and their disposition. A stale lock file or previous
commentary is not evidence that a job is live.

Before a long pause, persist this ledger, the candidate manifest, retained results,
budget window, reservations, and cleanup obligations in a durable destination.
Record secret references only. Recover them before spending or duplicating work;
missing temporary files do not reset the campaign's budget or prove old outcomes.

For a real publication approval gate, record the action, exact artifact identity,
destination, existing authority, and whether it is current or superseded. Keep
source publication, build, image publication, and credential transfer distinct.
Do not introduce new approval requirements beyond the actual execution policy.

## 6. Release handoff

```markdown
<Harness> is ready for <exact target> with <explicit limitations>.

User-visible outcome:
<What works and where it runs.>

How to try it:
<Normal install/setup, configuration, task action, result access, Stop/restart.>

Evidence:
- Shipping commit/package/image/profile:
- Required Product cells: <passed/required>, environments, attempts:
- Runner protocol results, reported separately:
- Clean installation and actual platform proof:
- Real authenticated canary, if required:
- Cleanup and resource disposition:
- Required CI/local checks, incomplete runs and retained failures:
- Budget: measured / reserved / unknown:

Limits:
<Unverified models/platforms/capabilities, accounting and recovery constraints.>

Rollout/rollback:
<Fresh admission, active sessions, historical reads, artifacts, recovery.>

Next action:
<Exact remaining review/merge/publish/deploy action and its authority.>
```

Do not write “production ready” when only the source patch or protocol probe is
ready. Do not write “all tests pass” when required cells were unattempted or the
full command was interrupted. Link the concrete evidence instead of a local
scratch directory. For Paperclip issue work, register the artifact/work product
and link it before setting the final issue status.

Before sharing, make every principle and conclusion understandable from the
record itself. Include the failure mechanism, correction, reproducible test,
expected result, and actual sanitized observation. Do not use private chat/task
links, personal filesystem paths, or inaccessible campaign archives in place of
that explanation. Code references should be repository-relative; external
research references should be public official sources. Secrets and raw sensitive
traces remain restricted and never enter the shareable skill or playbook.
