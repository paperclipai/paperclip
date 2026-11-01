# Restricted evidence for manual AWS E2E runs

The manual AWS workflow has a separate restricted evidence route. It uses the
existing private-history bucket, protected environments, OIDC role and bounded
archive transfer. It does not change the scheduled private-history lane.

GitHub Actions artifacts in a public repository are readable by repository
readers. They are not an organization-private evidence store. The restricted
route never uploads raw cell evidence or a merged report to Actions, S3 public
history, or Pages. This stays true on setup failure, launcher failure and report
failure. Previously staged files do not enable a public fallback.

## Supported selections

An approved original run selects at most **eight** distinct execution IDs from
one fixed registry of the frozen 244 chat scenarios. All use profile
`runner-opencode` and environment `local`. The 242 catalog tasks retain their
exact `area.case` IDs. The two standalone scenarios retain their existing task
IDs: `tasks.create-backlog` maps to
`chat-features.runner-opencode.local.create-backlog`, and
`tasks.delegate-announcement` maps to
`chat-features.runner-opencode.local.delegate-announcement`. The dotted task
aliases are not registered. The exact registry is in
`tests/runner-e2e/manual-private-retention.ts`.

These IDs require the reviewed AWS Fleet route. Broad chat suites, mixed
unsupported IDs, reruns and missing approvals fail closed. All chat-feature IDs
are classified as restricted by trusted code. A target descriptor cannot opt out.
Other manual selections keep the existing Actions route only after a trusted
per-cell check confirms that the actual selected execution is not restricted.
Selector whitespace and exclusivity follow the catalog producer.

The registry size does not increase the per-run limit or the eight fixed report
read slots. Classification, cell binding, every approval row and session policy
reject a private selection larger than eight before actionable outputs or archive
credentials. Generic nonprivate catalog selection retains its existing semantics.

A registered ID is not a claim of feature readiness or permission to run it.
Each target still needs the exact reviewed producer contracts, matching helper
bytes, declared private inputs, fresh source fingerprints, an available original
attempt and exact operation approval. Earlier accepted target branches do not
acquire these bytes or approval automatically. Running jobs keep their pinned
sources. No retained grade or historical qualification transfers to a new target.

The private cell report contract binds the installed pinned Playwright producer
and the selected cell before it accepts canonical static trace files. Default
cell evidence keeps its existing unknown-carrier rules. Excluded installed build
staging is outside the evidence tree; unknown carriers inside standard evidence
paths still fail. A target with stronger ZIP or embedded-report scanning must
retain those checks when it adapts this contract. Installed-target identities
and runtime evidence remain separate from source-preparation metadata.

## Deployment and operator gates

This source change alone does not configure a role, bucket, environment, target,
or run. Before a supported run, the operator must:

1. Deploy this workflow and its helpers together on the protected default branch.
2. Keep the existing numeric actor allowlist and protected default-branch checks.
3. Keep `runner-e2e-private-paid` and `runner-e2e-private-history` restricted to
   the default branch. Establish administrator-controlled approval for the exact
   source and original run. A reviewer UI may supply this control but is not
   mandatory. Prove the actual control and runtime contract before admission.
4. Provide the existing private-history role ARN, AWS region and bucket variables
   in those environments. The existing role must support the existing bounded
   prefix and bucket-policy, ownership, public-access and retention reads.
5. Provide `RUNNER_E2E_MANUAL_PRIVATE_APPROVALS_JSON` through administrator-controlled
   configuration available to both protected jobs. Approve the exact resolved
   workflow SHA, target SHA, original run ID,
   attempt `1`, selected execution IDs and launcher SHA-256.
6. Use a reviewed compatible target. Its private handoff and policy modules must
   match the workflow implementation byte for byte. Its launcher digest must
   match the protected approval. Earlier target branches do not gain this
   protocol automatically.

Classification happens before the protected job. It grants no archive authority.
The administrator-controlled record must bind the actual original run ID before
target dependency setup or archive credentials. Prove who can change that record
and that each job consumes the exact approved record. An environment reviewer
gate is one way to govern authorization; its UI is not required. A missing or
stale row still fails closed before target dependency setup, archive credentials,
model credentials or fixture secrets. There is no wildcard approval.

The variable has this closed shape (all values below are placeholders):

```json
{
  "version": 1,
  "approvals": [{
    "workflowSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "targetSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "runId": "123456789",
    "attempt": "1",
    "executionIds": ["chat-features.runner-opencode.local.activity.agent-feedback"],
    "protocol": "paperclip.manual-private-evidence/v1",
    "launchSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  }]
}
```

## Trust and credential lifetime

The workflow checks out its own immutable `github.sha` into a separate directory.
It prepares pinned publication dependencies with `--ignore-scripts` and a
separate store before archive credentials. Transfers use that checkout's
absolute helper, tsx and archive-script paths. They do not load the target's
node_modules or an ambient Node loader. The target executes only after the
protected approval and private-storage preflight pass.

The AWS action returns session credentials as step outputs, not job-wide
environment exports. Only trusted preflight and transfer steps receive those
outputs. Transfers require an explicit complete session and disable EC2 metadata
fallback. A failed or expired session fails retention. It never enables an
Actions upload. Exact-key session policies limit the intended transfer calls. Each current cell
uses its own two-object read session; the report writer uses a separate session.
Every generated policy is checked against the 2,048-character STS limit before
the credential action. No wildcard object access is added.

This is **operator-approved target execution**, not a sandbox for malicious
source. The protected job has OIDC permission. Its target launcher can inherit
the GitHub OIDC request environment, and the existing harness copies its process
environment into server/native children. A target that can request a new OIDC
session may re-assume the role. An inline session policy does not prevent that.
Reviewers must approve the complete exact target, not just its evidence flag.
This change does not alter IAM, OIDC trust, host roles or credential duration.

## Evidence and failure rules

The launcher keeps its ordinary standard evidence in an owned temporary root.
It preserves the original framework result before launcher result updates. It
also seals final packaged results after cleanup and campaign finalization.
The transfer validates exact file inventories and hashes before archiving.
It excludes instance databases, workspaces, credential registries, auth files,
raw capture directories and arbitrary files outside the standard evidence scope.
Free-form launcher console capture is not an approved retained carrier.

The existing credential scanners and PASS PNG, HTML, blob and snapshot checks
still apply. Original text, ZIP and media bytes receive those scans before
retention. Raw and encoded registered roots and provider-shaped names are also
rejected from original paths and inventories. Unknown extensions and SVG files
that the ordinary packager does not inspect cannot become complete originals.
Files cannot be silently dropped to meet a bound. Credential contamination,
unsupported carriers or a changed inventory stop the transfer. Missing required
PASS files still convert the attempt to infrastructure FAIL. The private inventory
retains all safe available originals and records `requiredEvidenceComplete: false`
and the exact missing list. Its `complete` field means the available file inventory
is complete; it does not certify PASS evidence completeness. Failed framework
attempts do not claim that PASS evidence checks ran. No file is synthesized and
no secret-bearing original is uploaded just because the bucket is private.

The existing archive bounds remain unchanged: at most 256 MiB of source files,
4,097 archive entries and 264 MiB transferred archive bytes. Duplicated original
and packaged files count toward those bounds. A run that exceeds a bound does
not have complete retained evidence and needs an explicit disposition.

Private objects use immutable conditional puts and version receipts under
`runner-e2e-private/bounded-v1/campaigns/gha-RUN_ID-1/`. Each cell has a hash-derived
object name. The report reads only the approved current cells and verifies each
archive against its retained transfer digest. Fresh merged HTML, blob, normalized output and report logs receive a final
standard-file scan and sealed inventory with the actual current report-step
credential roots, including its explicit AWS session. The report uses the same
raw, encoded-root and provider-shape checks before transfer. It retains the
scanned report in the same restricted store. A report error stays a report
error; retention does not change its grade or manufacture a public page.

Authenticated retrieval uses the existing private-history operator machinery
and approved bucket access. This PR does not grant a reader role or perform an
upload. Actual deployment, environment approval, compatible target fingerprints,
private storage access and one exact run approval remain operational gates.
