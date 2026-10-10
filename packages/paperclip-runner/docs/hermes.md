# Hermes native runner (pending qualification)

Hermes runs as a per-turn native ACP process through ACPX 0.13.1. The bridge
adapts questions, active steering, tool policy, accounting and strict recovery;
Hermes retains its own agent loop, native tools and memory. There is no Hermes
gateway daemon, native cron scheduler, or SQLite polling transcript adapter.
The standalone `hermes_local` and `hermes_gateway` adapters retain their contracts.

## Distribution

The source-owned declaration is `src/providers/hermes/version.json`: release
`v2026.9.24`, commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`, Python
3.12.14, ACP SDK 0.9.0 and ACPX 0.13.1. Provisioning verifies the source archive
and upstream `uv.lock`, then installs the locked ACP, MCP, Anthropic, Bedrock and
Google extras. Use uv 0.12.17. No installation occurs during an agent turn.
The source download uses GitHub's immutable codeload archive and checks the
existing archive digest. Transient HTTP failures receive at most three attempts
within two minutes; throttling respects `Retry-After` up to 30 seconds and longer
delays produce an actionable setup failure. Downloads require no credentials.

```sh
# From the repository root, with an absolute, nonexistent destination:
node packages/paperclip-runner/scripts/provision-hermes.mjs \
  "$PWD/packages/paperclip-runner/provider-assets/hermes/darwin-arm64"
# Linux amd64 uses the linux-x64 destination instead.
```

For an installed public package, run `paperclipai runtime setup hermes` as the
same OS user that runs Paperclip. The command uses the packaged setup entrypoint
and materializer, downloads public pinned dependencies without model calls, and
verifies all execution bytes before publishing the runtime to
`~/.paperclip/runtimes/hermes/<platform>/<closure-digest>`. It re-verifies an
existing installation and refuses to overwrite invalid state. Setup is explicit;
npm lifecycle hooks and agent turns do not provision Python. Read-only or global
npm installations use this account cache without writing to the package directory.

The materializer emits a complete closure digest. Compare it with the reviewed
platform pin in `hermes-distributions.ts`; never adopt an unexpected digest at
runtime. Runtime launch verifies the installed bytes and host sandbox before
credential staging, then opens a private verified snapshot for execution.
Python uses `-I -B` and the bundled interpreter.
The public server package carries the bridge, provisioner and materializer; Python is a separately
provisioned asset, included by `--candidate-providers=hermes` in provider packs.

macOS command tools require `sandbox-exec`. Linux command tools require
`bubblewrap` and permission to create its process/mount namespaces. Installing
bubblewrap alone does not grant that permission. A default Docker container
was observed to reject namespace creation; setup fails before credentials are
staged there. Actual Daytona namespace behavior remains a qualification
requirement. Building a provider pack verifies its bytes without probing the
builder's sandbox; the execution host performs that probe at admission.

Maintainers build the qualification image in the cloud with
the **Docker Runner check** workflow, which defaults to standard GitHub-hosted
Linux. The existing EC2 fleet remains an explicit option. Select `publish_eval_image=true` and
`candidate_provider=hermes`, and select the source branch with `target_branch`.
The workflow resolves that branch to an immutable commit before checkout. The
image-only job has a 45-minute deadline, includes the pinned Linux runtime,
signs its digest and verifies public retrieval, image labels and provider-pack
identity. It uses no model credentials or inference. Its retained artifact
contains the immutable image reference and verification records.
It also exports the exact image-owned Linux runner binary and controller
provider pack, with file and archive SHA-256 records. A Mac controller can
download and verify that bounded artifact without starting Docker or pulling
the complete image locally. The export contains public runtime assets only;
model credentials are excluded.

This image build does not prove that an execution host permits Hermes's sandbox
namespaces. Actual Daytona tool execution and restore remain separate release
gates. The full-stack campaign workflow retains its own content-addressed image
and signature contract.

## Connections and identity

Use the existing account/model picker and the `hermes_runner` managed projection.
API keys map to the matching native provider. Codex and Grok subscriptions are
projected into Hermes auth.json and translated back through existing freshness,
ownership and revocation checks. Claude subscriptions use the existing managed
OAuth-token path. Custom Chat Completions, Responses and Messages routes retain
their protocol, endpoint and authentication choice. Bedrock retains its managed
region and bearer credential. These are implemented projections, not evidence
that each provider/method has passed live qualification.

Native execution input v7 carries a value-free connection fingerprint and
optional authorized attachments. Existing v1–v5 inputs and Dot v6 remain
replayable. The reader also accepts recorded Hermes v6 qualification inputs
when their provider is explicitly ACPX Hermes, normalizing them to v7. The
fingerprint covers the selected account epoch and routing configuration; token
refresh does not replace a compatible session. Model, account, endpoint and
permission changes use the existing replacement rules.

Credentials use the ephemeral runtime path and process-lifetime fence. Native
auth, refresh handoff, configuration, environment files and diagnostic logs are
excluded from recovery copies. Only `hermes/memories` and `hermes/skills` enter
managed agent-file storage. Session databases stay private to a normalized
conversation. Assigned Paperclip skills remain separate protected inputs.

Between turns, authenticated run attachment refreshes the registered agent-file
working copy and assigned tool bindings. The session still pins prompt, bundle,
skill, connection, model, and permission identities. Unknown policy changes and
changes within the same run are rejected.

Native session admission has a 60-second bound for the verified private Python
copy and ACP initialization. The controller allows 75 seconds around cold
startup, recovery and later-turn restoration. Once a turn is accepted, its
start-event deadline remains 30 seconds. Ordinary commands, cancellation and
process cleanup retain their existing bounds; this startup allowance does not
extend the task's execution deadline.

## Interaction contract

- Reasoning and assistant text use distinct message identities. Native tool
  call IDs preserve overlapping calls and edit snapshots.
- Assistant message identity v2 includes the provider message and provider turn.
  A final snapshot replaces only its own deltas, retaining preceding commentary
  and steered messages. Providers without message IDs retain the original
  identity. If a provider first supplies an ID after an unlabelled prefix,
  that prefix and the continuation retain one item identity and one final
  snapshot. A later distinct native message gets its own item. Existing PRP v1
  events replay unchanged. This is an identity change
  within the current event contract, not a new wire field or transcript rewrite.
- Native questions publish a 65,536-character limit for text and custom
  answers. The form, canonical response validation and bridge count UTF-16
  code units consistently, so an accepted answer can resume the native callback.
- Images accept PNG, JPEG, WebP and GIF; documents accept UTF-8 text/Markdown.
  Limits are eight attachments, 2 MiB per item and 4 MiB total. The combined
  message and attachments also have a 7 MiB JSON-encoded limit, including
  escaping and metadata, to fit the encrypted Runner command frame. The controller
  authorizes and reads content before the turn; URLs and arbitrary local paths
  are rejected. Models without image support can reject image input.
- The negotiated `_meta.paperclipHermes.version = 1` extension uses ACP wire
  methods `_hermes/turn_started`, `_hermes/ask_questions`, `_hermes/steer`,
  `_hermes/usage` and `_hermes/delegation`. Python's ACP SDK adds the leading
  underscore. Questions and controls bind to the active session and turn token.
- Steering requires an explicit native acknowledgement. Follow-ups remain in
  the durable Paperclip queue. Stop cancels native work and pending input before
  bounded provider-process cleanup.
- Restored history is recorded without becoming new assistant text or live tools.
- Restoration requires nonempty native history and follows the native
  compaction chain. Missing history and failed persistence are errors.
- Usage is a per-prompt delta. Clients negotiate `billingReceipts: 1` inside
  `_meta.paperclipHermes`; the optional closed `paperclip.usage.billing/v1`
  receipt remains replay-compatible with older events.
- Direct Anthropic Messages and OpenAI Chat Completions/Responses clients also
  negotiate `tokenAccountingReceipts: 1`. The optional closed
  `paperclip.usage.tokens/v1` receipt binds the selected API account, exact
  requested model and protocol to all observed synchronous wire attempts,
  including retries and auxiliary calls. It contains disjoint token buckets,
  request counts, completeness and verified standard/short pricing context,
  with no price, prompt, response content or credentials. Only complete,
  matching receipts can receive Paperclip's labeled rate-card estimate.
  Anthropic cache-write TTL is unavailable, so estimates use the documented
  one-hour upper rate. Missing history or older events without this optional
  authority cannot certify complete direct-API usage. They remain replayable.
- For the managed OpenRouter Chat Completions route, the bridge observes the
  pinned SDK's wire responses and sums provider-reported `usage.cost`, including
  retries and auxiliary synchronous calls. The receipt carries request counts,
  completeness and an exact nine-decimal USD amount. Paperclip binds it to the
  selected OpenRouter billing identity and the current native turn before
  using it for accounting. Cumulative session cost and native model-price
  estimates cannot supply this receipt.
- During Stop, requests and steering close immediately. The same admitted
  Hermes prompt may still deliver its final usage notification with the exact
  native session and turn token before prompt settlement. Stream or process
  closure ends that receipt window. Missing charges remain unpriced.
- Failed, interrupted, unsupported asynchronous and background delegated work
  leave measurement totals incomplete. Known positive reported subtotals survive, but
  missing charges remain unpriced. Explicit reported zero is accepted only for
  a complete receipt. Direct API token authority permits an estimate without
  claiming provider-reported dollars. Unsupported routes, models, processing
  tiers, long requests and incomplete attempts stay unpriced. Complete live billing, including delegated
  work, remains a qualification gate; these checks do not qualify a provider.
- Once the native provider boundary closes, an optional versioned accounting
  settlement can acknowledge that known subtotal even when tokens or charges
  are incomplete. Missing token totals stay unknown, incomplete charges stay
  unpriced, and the existing controller finalization and capture-failure fences
  still control acknowledgement. Older incomplete receipts remain pending.
- A governed input wait can stop transcript consumption before native usage
  arrives. For Hermes's per-turn lifecycle, the runtime joins the authenticated
  notification mapper after owned shutdown and reads its last usage event.
  This read-only fact must match the original runner, session, run and turn,
  then enters the existing durable accounting journal. It cannot reopen tool
  authority. Missing, invalid or timed-out reads do not invent usage or cost.
  This optional execution-result field carries an existing v1 PRP event; it
  does not change persisted execution inputs or the Rust wire contract.
- An applied pending `request_human_input` response for a question, confirmation
  or checkbox confirmation stops Hermes in its native
  tool completion callback, before another model request. The bridge publishes
  that tool's completed result after native finalization. Both Runner event
  pumps read the prompt usage receipt before forwarding this completion to the
  controller. The tool bridge also defers its own completed human-input fact until
  the native terminal notification, which follows that receipt. The managed
  Hermes profile selects this launch policy; other profiles retain their
  existing order. Other tool activity still streams immediately. Tool identities
  and results are preserved; wait and accounting authority remain with the
  controller. Missing usage remains unknown.
- Paperclip owns task titles. Hermes keeps its immediate derived session title;
  its paid background title upgrade is disabled in the managed profile so it
  cannot start inference after a turn's usage receipt has closed.

The managed execution middleware applies planning/read-only, protected-path and
permission policy to inline, concurrent and delegated native tools. Assigned
MCP tools use the authenticated runner bridge; startup fails if that catalog
cannot be loaded. Ambient configured MCP discovery and unmanaged plugin/config
loading are disabled.

## Proactive work

Paperclip owns scheduling. Native `cronjob`, gateway messaging and native task
mutations are disabled in this profile. The live `manage_routine` semantic tool
creates, updates, pauses and resumes self-assigned routines through the existing
routine service. Updates require the current revision and retries require an
idempotency key. Listing/inspection use existing authorized read APIs.

Scheduled firings create ordinary Paperclip work with routine provenance and
retain existing ownership, budget, pause, concurrency and duplicate-fire rules.

Provisioning requires uv 0.12.17 and, on macOS, Command Line Tools for
`install_name_tool` plus `codesign`. The Python closure normalizes interpreter
installation paths so local consumers and image builds reproduce the same pin.
Credential cleanup runs after verified exit even when learned-state collection
fails; save failures remain visible through normal runtime errors.

## Qualification

Hermes stays visibly **pending**. Candidate execution is an operator diagnostic
opt-in, never enabled by agent-supplied session JSON. The server's existing
`PAPERCLIP_RUNNER_ACPX_QUALIFICATION` allowlist accepts an exact Hermes/model
entry. The runner CLI accepts `--candidate-profile hermes`.

```sh
pnpm --filter @paperclipai/paperclip-runner build:typescript
pnpm --filter @paperclipai/paperclip-runner test:hermes:transport
```

The browser campaign definitions and implementation record are supplied by
[qualification PR #15436](https://github.com/paperclipai/paperclip/pull/15436).
Apply that companion PR before running its commands:

```sh
pnpm test:e2e:runner -- --list --suite extended-harnesses
pnpm test:e2e:runner -- --id extended-harnesses.runner-acpx-hermes.local.hello-complete
```

The opt-in transport tests execute the pinned native process against a
deterministic HTTP model fixture. It is not paid-model, browser or Daytona
qualification. The fixtures exercise the ACPX host and the full TypeScript,
Rust PRP and packaged sidecar path, including image delivery and semantic task
completion. Native question batches cover single selection, multiple selection,
custom answers and free text. They require one callback result, reject a second
answer, and check both question cancellation and Stop during a pending question.
Stop must prevent a later model request and cannot produce task completion.
The companion Product E2E catalog contains five local and five Daytona
Hermes cells using a managed OpenRouter connection. Each connection method,
native control, attachment, persistence, remote restoration and permission mode
must pass its release criterion with inspectable live evidence before promotion.
The implementation record is included in that qualification PR.

The `Hermes Native Transport` PR workflow builds and runs the same native fixtures
on GitHub-hosted Linux amd64 and Mac arm64, with a stripped provider environment
and deterministic loopback endpoints. Its CI artifacts include source checkout
and tree identity, runtime closure, tool versions, fixture logs, and a checksum
for the exact staged daemon used by the fixtures. A binary archive preserves
executable permissions for subsequent acceptance work without local Rust builds.
Check the recorded job and fixture outcome before using an artifact; failed jobs
also retain evidence. This is credential-free transport and host-sandbox evidence;
it does not replace paid-provider, browser, subscription or Daytona qualification.
