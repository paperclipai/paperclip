# Slack connector behavior checks

Keep Slack-specific guidance and acceptance probes next to the connector.
Production per-turn guidance is in [`../agent-guidance.ts`](../agent-guidance.ts);
individual action descriptions are in
[`packages/shared/src/slack-tools.ts`](../../../../../../packages/shared/src/slack-tools.ts).

## Coverage and gaps

[`cases.json`](cases.json) defines twelve neutral user prompts with fixtures,
independent expected outcomes, required evidence, and related deterministic
regressions. These are **manual model acceptance probes**, not registered Runner
or Product E2E workflows. Running the regressions does not run those prompts,
invoke a model, or contact Slack. Each linked regression covers part of the
contract; its pass does not establish the probe's complete outcome.

| Feature | Guidance to preserve | Acceptance probe |
| --- | --- | --- |
| Choice questions and forms | Use saved Paperclip questions; Slack controls answer and resume the same task. | `choice-question`, `question-form` |
| Files | Current-chat artifact handoff; explicit uploads elsewhere use an existing attachment. Verify delivery. | `file-reply` |
| Mentions and replies | A bare mention starts a real conversation; unmentioned thread replies continue it. | `thread-followup` |
| Search and history | Use authorized sources and real permalinks; disclose bounded coverage. | `search-coverage` |
| Private research | Honor source/destination restrictions, including files. | `private-source` |
| Posts, reactions, pins, bookmarks | Ordinary replies are delivered automatically; explicit actions use assigned tools. | `explicit-post-and-reaction` |
| Uncertain writes | Keep the operation identity and inspect delivery; never resend with a new key. | `uncertain-write` |
| Destructive changes and invitations | Honor the saved action policy and approval decision. | `approval-decline` |
| Canvases and lists | Use advertised capabilities; explain plan/scope limitations without inventing success. | `canvas-list-availability` |
| Task links | Use the server-provided public URL. | `task-link` |
| People joining | Give the saved bot command, personal confirmation flow, and company-access approval. Channel invitations do not grant Paperclip access. | `invite-person` |

Pins, bookmarks, channel topics, invitations, list edits, and channel creation
have tool descriptions and transport fixtures but no dedicated model probe here
yet. Those provider channel invitations are distinct from the `invite-person`
account-linking guidance probe. The canvas probe does not qualify list editing. Automatic app creation,
OAuth, setup navigation, and installation recovery are a separate onboarding
surface covered by the existing setup and browser tests.

## Run deterministic regressions

From the repository root:

```sh
pnpm test:slack-connector --list
pnpm test:slack-connector --case choice-question
pnpm test:slack-connector
```

The selector runs existing Vitest files; it adds no grader or parallel eval
framework. Local HTTP/database fixtures may need normal development permissions.
It deliberately omits `chat-channels.integration.test.ts`, which requires an
isolated migrated database. Never point that suite at a live test-drive database.
With a disposable database supplied, run the supplementary integration checks:

```sh
PAPERCLIP_TEST_DATABASE_URL=<disposable-database-url> pnpm exec vitest run server/src/__tests__/chat-channels.integration.test.ts -t 'refreshes Slack tool guidance|provides assigned Slack tools|binds Slack tools to the admitted linked request'
```

The catalog records additional large-suite fixture locations for write,
approval, lifecycle, and canvas/list behavior. Select their exact test names
from that file when investigating those features.

## Run a model acceptance probe

Use an isolated Paperclip company and explicitly authorized Slack workspace and
destinations. Seed synthetic content and record the expected result before
starting. Send the case's neutral prompt through the real conversation, retain
the required evidence, and grade actual provider state rather than agent prose.
For questions, answer through Slack and observe the continuation. For files,
download and inspect the delivered bytes. Inject uncertain-write faults only
through a controlled provider fixture.

Record the Paperclip revision, case/version, model and adapter, legacy/native
runtime, effective tool policies, fixture identity, run/task/interaction/action
IDs, timestamps, actual provider result, sanitized evidence, and cost when
available. Distinguish model failure, product failure, fixture failure,
authentication/permission failure, and infrastructure failure. A missing
evidence item is unverified, not a pass. Never retain tokens or private customer
content in the evidence.

The attended zoo-question test on 2026-10-07 exercised legacy `codex_local`
(`gpt-5.6-sol`) with real Slack choices, saved answer, same-task continuation,
and a delivered correct answer. Its task was
`34d0ce26-0040-4689-a97c-f76d975abeaf`; the question message was
`1791402669.801139` and the final reply was `1791402744.785019` in the authorized
test DM. It does not qualify every case or native runtime.

The [2026-10-08 acceptance record](2026-10-08-acceptance.md) attempted the ten
remaining cases through Carlos: five passed, two failed, and three were partly
verified. It includes sanitized durable evidence, invalid attempts, runtime
qualification limits, and the controlled uncertain-write boundary. These
results do not constitute a fully passing campaign.

To automate these probes, extend the canonical
[`tests/runner-e2e`](../../../../../../tests/runner-e2e/README.md) Product E2E
catalog and evidence/grading path. Runner-only protocol cases belong in the
separate `paperclip-evals` repository. Follow
[`doc/evals.md`](../../../../../../doc/evals.md); no Slack model campaign is
registered or launched by this folder.
