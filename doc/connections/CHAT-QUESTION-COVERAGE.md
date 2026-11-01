# Chat channel question coverage index

This is the index of per-provider question qualification records. The
[connector playbook](./CONNECTOR-PLAYBOOK.md#question-experience-inventory) owns
the Q01–Q11 inventory, control-selection principles, and acceptance standard.
Keep that inventory and this index in sync when a channel or question experience
changes. Provider capability flags alone do not establish support for a form.

## Provider records

The provider list comes from `CHAT_PROVIDERS` in
`packages/shared/src/types/chat-channels.ts`. Add a record for a new provider;
update the affected record for a changed form. An unaudited row means this index
has no qualification record for it, not that the provider lacks controls or that
its existing implementation is broken.

| Provider | Q01–Q11 record | Scope and status |
| --- | --- | --- |
| Slack | [October 24, 2026 baseline](#slack-october-24-2026) | All eleven core experiences observed in real Slack against a local candidate; limited scope below. Later changes require affected-case remeasurement. |
| GitHub | Not yet indexed | Audit all applicable question paths, including comment replies and authenticated handoffs; no qualification claim here. |
| Discord | Not yet indexed | Audit all applicable question paths; no qualification claim here. |
| Microsoft Teams | Not yet indexed | Audit all applicable question paths; no qualification claim here. |
| Telegram | Not yet indexed | Audit all applicable question paths; no qualification claim here. |
| Speko | Not yet indexed | Establish applicable conversational paths and equivalents for controls; no qualification claim here. |
| AgentMail | Not yet indexed | Include email reply and authenticated handoff behavior; no qualification claim here. |
| iMessage Photon | Not yet indexed | Audit all applicable question paths; no qualification claim here. |

Do not turn an untested native path into “unsupported” or “not applicable.”
Research provider capabilities before choosing a response path. A text/reply-only
channel can meet the standard with an understandable, correctly bound reply or
an exact authenticated handoff; it need not imitate Slack's UI.

## Provider record template

Keep the record here or in a provider-specific document linked above. Use one row
per inventory ID and relevant variant. Every row needs a state, including gaps;
never drop difficult forms from the denominator.

Record metadata once per campaign:

- Accountable owner, date, source commit and dirty-tree fingerprint if relevant,
  provider/client surface, adapter/SDK versions, and redacted configuration.
- Test scope: local serialization, real-provider local candidate, live-model
  behavior, or deployed verification. Name a deterministic fixture as such.
- Source entry points: runtime input, composer/card, legacy payload, or canonical
  question set. List applicable variants and those not exercised.
- Authorized isolated bot/channel and conversation references, reproducible
  setup, evidence location accessible to reviewers, and cleanup outcome. Keep
  private conversation links and credentials out of public repository records.

Use this row schema:

| Field | Required content |
| --- | --- |
| Inventory ID and variant | Q01–Q11 or a newly added ID, exact payload/source entry point, and required/optional/default/size variations. |
| Provider capability and treatment | Native control, structured reply, or Paperclip handoff; official capability/limit reference and installed adapter behavior. Explain why this is the best feasible path. |
| Canonical mapping and authority | How the response maps to the saved question/decision, actor and conversation, including validation and current authorization. A review-link click is navigation, not a response or grant. |
| Functional status | Pass, fail, not run, or not applicable with reason; expected versus actual saved result, canonical continuation policy/count, artifacts, and delivery receipts. |
| Experience grades | Separate ✓/✕ for good experience and best feasible experience, with a short rationale after inspecting unanswered, answering, and settled states. Missing inspection is not run. |
| Evidence and history | Actual provider captures and link-click outcomes, durable-state correlation, failed attempts, repair/retest, and exact candidate for each attempt. |
| Remaining coverage | Untested variants, boundary/negative-test coverage, provider constraints, and any live-model or deployment gap. Name the next required check. |

Prefer a browsable per-format gallery. Keep the conclusions and coverage gaps in
this durable record or the PR even if its temporary preview expires. Sensitive
evidence can stay in an access-controlled artifact with an accessible reference;
do not copy secrets or private tenant data into the index. Reuse existing test
harnesses and publication/continuation contracts instead of inventing a provider
workflow engine to fill a matrix cell.

## Slack: October 24, 2026

Reference implementation and review:
[PR #17255](https://github.com/paperclipai/paperclip/pull/17255).
The local campaign's final implementation was recorded as
`c3d458b2a06b660448940fd8cf33c5906f0058d5`; captures were collected during its
implementation, with failures and repairs retained in the campaign gallery.
This is a historical evidence summary, not a certification of later PR heads
or staging. The PR verification section records later regression fixes/checks.

**Scope:** dedicated real Slack QA conversation, local server candidate, desktop
Slack client, and a deterministic agent protocol fixture. Each core case had an
actual unanswered/answered pair, saved result, one intended continuation, and a
published final reply. Open controls and validation states were captured where
applicable. The author inspected the gallery and graded each captured experience.
The local gallery remains in the originating work chat; it is not a public or
permanent hosted acceptance artifact. Reproduce affected cases when that private
evidence is unavailable to the reviewer.

The table describes exercised paths, not every possible payload within a kind.
The playbook defines the preferred behavior and broader variant requirements.

| ID | Path exercised in Slack | Observed functional result | Good / best feasible | Scope notes |
| --- | --- | --- | --- | --- |
| Q01 | Native multiline text modal | Pass | ✓ / ✓ | Full prompt/context, editable starting text, saved answer retained. |
| Q02 | Direct choice buttons | Pass | ✓ / ✓ | Descriptions and recommendation visible; selected label retained. |
| Q03 | Inline searchable single-select | Pass | ✓ / ✓ | Selected the thirteenth option by searching; saved label remained visible. |
| Q04 | Checkboxes and explicit submit | Pass after repair | ✓ / ✓ | Empty submission feedback, two selected labels retained, and one continuation after fixing multi-selection authorization. Original failure retained. |
| Q05 | Choice buttons plus **Other…** text modal | Pass | ✓ / ✓ | Both listed and custom answers exercised; descriptions and recommendation retained. |
| Q06 | Native text modal with inline validation | Pass | ✓ / ✓ | Invalid pattern kept the draft open; corrected answer saved and continued. Not every numeric/length variant was tested live. |
| Q07 | Accept/Reject buttons | Pass | ✓ / ✓ | Ordinary acceptance exercised. Governed and required-reason variants retain the canonical review path; not all were tested live. |
| Q08 | Checklist with Save and Reject | Pass | ✓ / ✓ | Defaults and bounds visible; over-selection rejected, correction saved, exact selection retained. |
| Q09 | Native per-item radio choices and reason fields | Pass | ✓ / ✓ | Required-reason validation and atomic submission exercised; decisions and reasons readable afterward. |
| Q10 | Create task, multi-proposal selection/Create selected, and Dismiss | Pass | ✓ / ✓ | Reviewed created task title/description/parent independently; clicked review and created-task links to their correct destinations. |
| Q11 | Authenticated **Review connection** handoff and native **Not now** | Pass after repair | ✓ / ✓ | Clicked the exact review destination and exercised decline without a grant; removed a spurious error caused by the passive link callback. No OAuth/access grant attempted. |

**Remaining scope:** these eleven cases do not establish all large/mixed-form
boundaries, every terminal state, mobile behavior, other providers, live-model
judgment, or deployed staging behavior. Deterministic regressions cover additional
authorization, duplicate-response, and fallback cases. Later review identified
oversized multi-select continuation and large custom-choice fallback defects;
their failed-before tests, fixes, and final-head verification belong to the PR
record and must not be hidden by this core-case scorecard.

**Cleanup:** restored the QA app's original callbacks, closed temporary callback
and read-only preview tunnels, and removed temporary local credential copies.
The read-only preview exercised navigation, not a connection permission grant.

### Lessons behind the quality bar

The PAP-701 investigation and this campaign exposed distinct failures:

1. A title plus **Respond** hid the actual question and context. Inventory
   question content and its answering path, not only interaction kinds.
2. The first eleven-case gallery proved saved results returned to Slack, but
   only three cases answered natively and only one passed the complete UX
   review. Functional parity and “native” are both weaker than a good experience.
3. Real multi-select submission saved correctly but failed continuation
   authorization. Inspect durable results and subsequent delivery alongside the
   screenshots; a settled card is not completion.
4. The connection review link reached its destination while its callback also
   displayed a misleading error. Click every relevant handoff/result link and
   inspect both sides before grading it.
5. Later boundary review found gaps beyond the core gallery. Keep core-case UX
   evidence separate from boundary coverage, retain failures, and remeasure
   changed paths on the candidate that will ship.

These are reusable acceptance requirements. The eleven Slack cases, particular
option counts, fixture choice, and temporary tunnel setup are campaign details;
future providers must research their own controls, limits, and delivery mechanism.
