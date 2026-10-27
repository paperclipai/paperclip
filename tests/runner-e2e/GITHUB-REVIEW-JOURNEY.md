# GitHub review bot journey (explicit, attended)

The `github-review-journey` suite converts the recorded Ponytail walkthrough into
fixed browser actions and an independent review oracle. It creates a GitHub App,
installs it on one private eval repository, saves automatic review configuration
with a selected skill and 5/5 passing threshold, opens a defective PR without a
bot mention, and checks the matching automatic task, review, GitHub delivery,
failed check, task completion, and persistence.

The suite is applicable to self-hosted deployments with public GitHub webhook
ingress and to Paperclip Cloud with GitHub App support. Hosting is independent of
the configured agent's `local` or `daytona` execution environment. Both cells are
registered; select exactly one and bind it in the private setup profile. Browser
registration and oracle tests do not establish live qualification of either cell.

## Dependencies and starting state

Use a dedicated private browser profile outside the checkout. Supply the intended
company, serving SHA, deployment mode, existing agent/model/provider/runtime,
review skill, agent environment ID, GitHub account handle, App owner, and private
reusable repository. The GitHub login identifier may be an email; the handle is
separate. The agent and its provider connection must already be configured.
A matching existing GitHub user connection is required; fresh user OAuth and
agent hiring are outside this variant. App creation and installation remain
measured UI actions with attended consent/passkey boundaries.

The browser, harness, and review agent need no external MCP tools. The agent uses
the task-bound GitHub review tools. The preexisting personal GitHub connection
is a separate product identity prerequisite; the product may store/expose it as
an MCP-backed connection. That does not supply MCP access to the harness or
review agent. The browser account controls the App and eval repository; the
agent consumes its own provider and task bindings. Harness access to 1Password
does not supply those product connections.

Private setup profiles bind credential aliases to environment variable names or
selected `op://vault/item/field` references. A 1Password service-account token
goes only to the resolver's `op` child, and browser processes inherit a limited
environment. Never commit passwords, mailbox keys, passkeys, cookies, auth traces,
or browser profile contents. A private optional `authentication` module and
config file can prepare an ordinary hosted session before measured actions;
the private QA implementation reuses Cloud's email-code authentication helper.

## Select and run

```sh
pnpm test:e2e:runner -- --list --suite github-review-journey
pnpm test:e2e:runner -- \
  --id github-review-journey.configured-agent.daytona.setup-and-first-review \
  --github-review-config /private/ponytail-qa.json
```

The private definition, reference-only setup example, credential setup utilities,
and source-step mapping live in `paperclip-evals/evals/product-journeys/ponytail`.
Its wrapper supports the host's Keychain bootstrap without putting a token in
shell arguments. The suite is excluded from `--all` and generated CI matrices.
It has no scheduler, public upload, or automatic retry. A full setup needs
attended external authorization. Do not claim it is an unattended CI journey.
In a terminal, each creation/installation pause also accepts the exact displayed
action and unique App name. Inspect that attempt's permissions first. The setup
profile is not authorization: use the current task's actual authority, including
any explicitly granted standing permission for disposable QA resources. Do not
repeat an already covered approval; obey any required host approval boundary.

## Oracle and ownership

`cart-total.js` is a newly authored deterministic precision defect, not an
assertion that the source walkthrough had identical fixture bytes. A passing
eval requires a complete assessment of that path and head, a relevant inline
precision finding, a score below 5, and a correctly failed GitHub check. The
oracle rejects a stale/foreign company, endpoint, issue, PR, or head, manual
triggering, missing findings/delivery, and false completion. It does not require
the source's exact 3/5 score. Persisted skill selection proves binding; this
variant does not yet independently verify a runtime skill-read receipt.

The rendered inline discussion must identify the created bot, `cart-total.js`,
the complete reviewed head, and the relevant precision finding. A summary that
mentions the defect does not substitute for inline publication. The review's
completed state alone is also insufficient: the actual run must succeed and the
associated task must reach Done. A native failure after publication fails the
journey and retains the publication evidence already observed.

The rendered check must match its exact GitHub run URL, score, and reviewed
commit. Its failure status comes from that check's header. Hidden re-run menu
items, a failure on another check, and words in the model's narrative do not
prove the conclusion. `github-review-check.spec.ts` covers this boundary in the
credential-free `test:e2e:runner:browser-support` suite. Task completion reads
the visible Status property's picker, before and after reload. Hidden controls,
SVG titles, and narrative text saying Done cannot satisfy that UI checkpoint.

Each attempt records endpoint, App, PR/branch, task, and run ownership. Cleanup
removes the owned endpoint, closes the owned PR/deletes its branch, and asks for
the owned App's removal. App identity must match the created endpoint, company,
agent, exact name, GitHub-confirmed owner/slug, and immutable App ID. Installation
management is recorded separately: uninstalling alone does not prove App deletion.
It retains the shared repository, account, provider/user
connections, and completed task evidence. An unconfirmed cleanup fails the
attempt; retain the resource receipt for recovery. Read the receipt before any
manual cleanup. Never delete by a guessed name or broad account search.

Registration render waits are bounded separately from attended confirmation.
The driver retains only the GitHub origin/path and control-presence flags when
the creation control is missing. On a known registration error page without auth
fields, it also retains headings, button labels, and alerts. It excludes query
parameters and authentication content. Reauthentication is a setup boundary,
not evidence that an App exists.
Cleanup also stops failed native runs that still own a retry, and requires the
normal run-only Stop acknowledgement. It never clears pending accounting debt.

The configured deadline and observed run limit bound the attempt. They are not
a hard provider-dollar cap or proof that no request outlives cancellation. Use
the existing budgeted Cloud operations adapter before automated paid campaigns;
this attended attached-agent variant does not replace that infrastructure.
Effective company/agent budget policies are recorded when readable. A route
that reports tokens without a dollar cost can stop on `unpricedUsagePolicy:
block` despite a zero legacy spend counter. Any authorized exception is a
distinct tested setup condition; normal fixture setup must not silently grant
it. Restore temporary exceptions after verification and retain their receipts.

The case declares a ten-minute provider-turn allowance within its fifteen-minute
body deadline. Read back the attached agent's effective timeout separately;
catalog metadata cannot increase a deployed agent's limit. If the target rejects
the required configuration or its lifecycle cannot settle, preserve that setup
failure and repair the fixture before claiming a qualified run.

Private normalized results and the existing Product E2E dashboard retain actual
model/provider, selected environment, serving SHA, setup ID, source hash,
checkpoints, screenshots, observed usage, partial cost coverage, assistance, and
cleanup. Missing usage remains unknown. Authentication screens are excluded.

`github-review-report.ts` uses the existing evidence sanitizer and manifest,
stages only declared screenshots, and verifies screenshot hashes and attempt
path ownership. The standard report inputs are `evidence/result.json`,
`evidence/evidence-manifest.json`, and `evidence/snapshots/`. A passing result
also stages the hash-verified persisted checkpoint as `evidence/final-state.png`
for the standard report's final-state requirement. A missing persisted screenshot
rejects that passing report. Raw private operator
receipts are outside the manifest. Existing report tooling imports these files;
no second runner or report service is required. A presentation repair must use a
new directory, preserve the original result/hash and failure, and dispatch no
provider work. Rebuilding a dashboard never qualifies a failed live attempt.
