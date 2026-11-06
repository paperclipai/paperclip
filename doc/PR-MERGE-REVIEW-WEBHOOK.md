# Advisory PR review notifications

The optional `PR merge review notification` workflow sends a private webhook
after a current, open, non-draft PR targeting `master` passes verification.
It does not approve or merge a PR. Webhook failures do not change PR CI results.

## Private configuration

Create a GitHub Actions environment named `pr-merge-review`. Restrict its
deployment branch policy to the `master` branch only, with no tag policy.
Keep these two values in **environment secrets**, not repository variables,
repository secrets, committed files, task comments, or workflow outputs:

- `PAPERCLIP_PR_REVIEW_WEBHOOK_URL`: a Paperclip routine webhook URL.
- `PAPERCLIP_PR_REVIEW_WEBHOOK_TOKEN`: its separate bearer signing secret.

Use a webhook trigger with `signingMode: bearer`. The routine should use
`always_enqueue` concurrency so separate PRs cannot be coalesced into one task.
Define required text variables `pr_url`, `pr_number`, `head_sha`, and `base_sha`.
The notifier sends only those identifiers. The receiving agent must treat them
as untrusted data and verify the repository, PR identity, and current revision.

Give the routine instructions to run `pr-merge-review` and publish its MERGE,
HOLD, or DO NOT MERGE recommendation on the routine execution's Paperclip task.
Require a fresh check of the head, base, reviews, required checks, and task gates.
Keep GitHub approval, merge, auto-merge, and public-comment actions disabled in
the instructions for this advisory phase. Configure the routine in Paperclip;
do not put instance-specific URLs or credentials in this repository.

## Delivery and verification

The notification workflow runs trusted default-branch code. It never checks out
PR code or downloads PR artifacts or caches. It reacts to the repository's PR
workflow completions, external check completions, and legacy commit statuses.
When adding another PR verification workflow, add its name to `workflow_run`.

The notifier reads the current PR's status rollup and branch rules. Both
`ci / verify` and `ci / e2e`, plus any additional required checks, must succeed.
Other checks must succeed or be explicitly skipped. A neutral result is not a
pass. Skipped optional routing lanes do not imply that their tests ran. The
advisory routine evaluates actual coverage and reviews before recommending merge.
The notification workflow itself and the optional CI profile exporter are
excluded from verification checks to avoid feedback loops.

A final refresh rejects head or base changes during evaluation. Paperclip's
idempotency receipt deduplicates events for the same PR, head, and base. A new
base can produce a new review. The routine must refresh again before its final
recommendation. Event delivery and host check visibility can race; notifications
are best effort, with no polling or delivery guarantee.

The HTTP request uses TLS, a bearer header, no redirects, and a 15 second timeout.
Logs contain fixed delivery states only. Request and response bodies, URLs,
tokens, and raw exceptions are never logged. Missing secrets skip delivery.

Run the focused regression checks with:

```sh
node --test .github/scripts/tests/notify-pr-merge-review.test.mjs
```

For setup verification, use Paperclip's webhook `setupPending` test mode before
activation. This verifies authentication and ingress without starting a review.
After the workflow is merged to `master`, inspect a real successful workflow
delivery and its linked routine task to prove end-to-end operation. A saved
configuration or a setup test alone does not prove that journey.

To pause reviews, pause the routine in Paperclip or disable its trigger. To stop
notifications, disable this workflow or remove the two environment secrets.
Rotate the trigger signing secret in Paperclip and replace the token environment
secret together. Keep the URL secret even though it has no embedded bearer token.
