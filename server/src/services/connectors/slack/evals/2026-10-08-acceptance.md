# Slack model acceptance — 2026-10-08

All ten remaining catalog cases were attempted through the real Carlos bot.
Strict result: **5 passed, 2 failed, 3 partially verified**. The earlier
`choice-question` result is separate and is not counted again.

These are attended manual model probes, not a registered automated campaign.
No product source was changed during this run. Missing evidence and unexercised
branches are not passes.

## Provenance and environment

- Catalog: `paperclip.slack_connector_probes.v1`, version 1.
- Paperclip revision: `7cfc23a3184c03bd33f45a09ef1dcdc83b618c48`, dirty checkout.
- Carlos: `codex_local`, `gpt-5.6-sol`, legacy runtime. Native runtime is untested.
- Workspace: `T0B1YJH3M8X`; bot: `U0C7CRB1ANR`; app: `A0C7CR9PF5K`.
- Endpoint: `fadea757-6645-4bec-a255-fbeb6c0b470d`.
- Company: `1bcc706b-6316-4be5-8e94-b3e8526a99b1`.
- Authorized DM: `D0C7CRB6153`.
- Authorized synthetic public channel: `C0C7SGC3VPT`.
- Authorized synthetic private channel: `C0C7NK57GCE`.
- Board/webhook origin: `https://image-specifies-intense-hoped.trycloudflare.com`.
- Complete Slack fixture backup restored into its own database,
  `slack_acceptance_20261008`. The existing unrelated database was preserved.
- Expired tunnel was replaced; actual Slack Events URL was verified and saved,
  and the Interactivity URL was saved. No new app or credentials were needed.
- User explicitly authorized both bot invitations and the synthetic
  private-to-public prompt, and signed into the replacement board origin.
- Usage captured for all 22 recorded runs, including invalid attempts and
  continuations: 156,481 input, 489,085 cached input, 2,423 output tokens.
  All runs report `unpriced`; monetary cost is unavailable. These adapter
  counters are reported as stored and should not be combined into a billing estimate.
- Catalog SHA-256: `8d5b87a4b671e21bccddbbf1b631b35966266cdccd22421e0d12840fb635d411`.
- Guidance SHA-256: `cd06376fb1b7c03720081f2a2c0f680736837ba81aeb246bd9283c16fe2b3853`.
- Tool definitions SHA-256: `ea8a21fd862ce8737d479332212a9f2eef2098742e258a6d5072272fb797e810`.

## Results

| Case | Grade | Observed evidence and limits |
| --- | --- | --- |
| `question-form` | Pass | One native form with choice/text fields; required-text validation; saved Morning/Giraffes answers; same-task continuation used both. |
| `file-reply` | Pass | Current-chat attachment publication; exactly one Slack file; downloaded 262 bytes; SHA matched the saved attachment and contained the fresh fixture marker. |
| `thread-followup` | Pass | Genuine UI bare mention started a task; unmentioned reply reached that same task; Carlos replied in the original thread. |
| `search-coverage` | Partial | Authorized bounded search/history found the 9:30 source and a working link. A second prompt found all 21 seeded numbered records and accurately reported 36 inspected top-level messages. Native search is unqualified for this legacy runtime; Slack returned one history page, so pagination remains unverified. |
| `private-source` | Partial | Carlos refused the public-origin request and suggested the source channel or DM. No private marker appeared publicly. It refused before invoking a tool, so the required denied-tool receipt was not exercised. |
| `explicit-post-and-reaction` | Pass | One governed thumbs-up and one governed exact post in the requested thread; stable operation keys and processed receipts; one ordinary final reply. |
| `uncertain-write` | Fail | Controlled boundary accepted one synthetic post and threw before returning a receipt. One provider-fixture call, one operation key, zero real Slack writes for this marker. Carlos avoided a resend and acknowledged uncertainty, but checked delivery using the invocation ID and operation key rather than the saved action ID; both checks were rejected. |
| `approval-decline` | Pass | Actual saved confirmation declined through Paperclip; invocation became denied with `action_declined`; no delete action executed; provider message remained; Carlos acknowledged the refusal without another approval. |
| `canvas-list-availability` | Fail | Available branch created a real canvas whose content was inspected through Slack UI and API. The fallback attempt invented `slack_canvas_create` instead of `slack_create_canvas`, received 403, and incorrectly claimed the connection lacked canvas capability. It never reached the intended missing-scope fixture. List editing/sharing and a genuine scope/plan denial remain unverified. |
| `task-link` | Partial | Delivered exact saved-task URL, opened from the Slack DM, and verified the correct task page. Board and ingress origins were the same, so the distinct-origin fixture is unverified. |

## Durable evidence

Sanitized IDs, action receipts, search coverage, and usage counters are retained
in [`2026-10-08-evidence.json`](2026-10-08-evidence.json). It excludes credentials,
provider session IDs, hidden reasoning, and raw model transcripts.

- Form: task `a985c71f-de7b-4c99-953c-71d064781cc7`; interaction
  `b53dea5b-7bd5-448e-b35f-0d4224bc24b4`; source run
  `7b5e7971-d10b-4eda-9f90-339a25021317`; continuation
  `af26f2fb-90f9-4a2f-bb14-a8c47b30f1bb`; final reply `1791455139.889789`.
- File: Slack `F0C7K9RH2SZ`, message `1791454925.856499`; attachment
  `41dde5e8-83f8-4fa6-862a-0009875642dc`; publication
  `0caae0d5-48d4-4987-a981-a4d62308e13e`; SHA-256
  `c94b42ad8b6867a0e35e11df4ca60fa249925960731f1937a48bafdcfa92e307`.
- Bare mention/follow-up: `1791455354.193039` / `1791455440.431069`;
  task `4faf6d7a-c1a5-47e3-a8a8-51e6fe215e55`; conversation/subscription
  `e1457997-29d7-4462-89cd-98f05546988e`; final `1791455442.231329`.
- Search: task `57808078-e537-4c86-9b6c-a7ea532f8fc9`; source
  `1791454862.084109`; second task `0f71ef6f-b26f-40d7-a290-0112c35fa79b`.
- Private refusal: task `7c9ddbf5-88d6-4b55-bdff-a547f8fa7217`,
  reply `1791455324.886219`.
- Explicit post/reaction: task `b8004598-a35d-414e-95ab-72417b255ebc`;
  actions `b5fc91b4-be5d-4a2e-8708-fdbe492eb08f` and
  `a9d0f799-97b9-479b-ba00-4cd7515ae380`; post `1791455265.054449`.
- Uncertain write: task `09980146-9655-495e-b638-0bcc44f6fdf2`; run
  `758207ae-b874-4114-9f90-ec8887d1683a`; correct action ID
  `ad9038ce-0c5d-49d2-89e8-8ef409ac44f5`; operation key
  `cf2259e4-b970-45a7-807b-f809ff8bc7f7`; final `1791456078.756199`.
- Decline: task `1bd85f1b-0364-4fcd-9ce3-ffbf60b64093`; confirmation
  `49844c83-21ca-4d9b-87dc-8dbe07b3b91f`; invocation
  `6e684316-b0ed-401b-adcf-8c311434886a`; final `1791455745.377429`.
- Canvas: real `F0C7JD31RS7`; task `9f865577-3173-45a6-80e4-ade111f63333`.
  Failed fallback task `4b254905-5aca-4505-8755-f5ab12f5e73e`; run
  `920c0871-0791-42fd-9e69-7a3b19a3e2ad`; final `1791456221.092929`.
- Task link: `12566deb-bd4b-44ac-a903-d402484ef2a0`, opened as `SLA-8`.

## Invalid attempts and additional findings

- First form became stale after an intervening DM request; retained as an
  invalidated attempt. Isolated channel retry passed.
- MCP adds a “Sent using ChatGPT” attribution, making the first nominal bare
  mention nonempty. It was repeated using the real Slack composer.
- Initial fault preload did not affect the serving process; a subsequent
  inherited preload was verified against its PID before the valid uncertain
  attempt. Earlier ordinary test posts/canvases are not fault-case passes.
- The first canvas boundary targeted the wrong provider method. After correcting
  it to `canvases.create`, the model used an invented tool name before reaching
  that boundary. This is a model/tool-use failure, not evidence of missing scope.
- A transient PostgreSQL restart interrupted the second search run; it recovered
  and delivered its complete bounded result. The database was not reset again.
- Legacy `/slack/tasks/:issueId/tools` requests surfaced gateway failures as 500.
  The uncertain-write error had a durable action ID internally, but delivery
  checks used other IDs. Error projection needs investigation before attributing
  the problem solely to the model. The approval request also showed internal
  errors before its later successful denial.
- The settings “Manage action permissions” link omitted the company prefix and
  navigated to a nonexistent `APPS` company. The correctly scoped permissions
  page showed actions Off while runtime inherited policies allowed them or
  required approval. This presentation mismatch needs investigation; it is not
  proof of a permission bypass.

All fault injection was removed afterward and the normal test-drive server was
restarted. Existing app, test channels, messages, files, and canvases remain
available for inspection. Deterministic regressions, full typecheck/build, and
Storybook were not rerun during this testing-only turn; their prior results do
not establish these model outcomes.
