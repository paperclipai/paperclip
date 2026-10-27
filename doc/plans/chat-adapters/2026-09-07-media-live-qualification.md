# Images and files — live qualification, September 7, 2026

This is an incremental evidence log, not a blanket production-readiness claim.
Live provider actions use the signed-in in-app browser. The isolated Paperclip
instance is on loopback port 3103; only verified webhooks are publicly routed.

## Reproduced user failure

Discord CHA-4 run `9b90ddaa-6d82-4685-84b1-9483c30de346` generated and uploaded a
2,111,878-byte PNG. Artifact `43104a30-4ae5-4078-a880-68c9f9720318` pointed to
attachment `7abdf671-1eb2-402a-8417-274b048c39ed`, but the attachment had no comment
binding. The run's final publication contained no attachment IDs. The bot's claim
that the image was shown was false. Both the npm CLI attempt and a workspace-local
CLI fallback failed. The image itself was intact in Paperclip storage.

The audit also found a second path: a successfully bound, during-run attachment
could remain internal when a different final presentation comment was published.
An explicit same-run attachment handoff and a bundled API-based artifact helper
now pass the normal live workflow below. Independent review additionally hardened
immutable upload provenance, the per-turn file cap, and helper retries.

## Native transport checks

One known, non-sensitive orange-cat PNG and a 128-byte text fixture were uploaded
through Paperclip's Board attachment API and explicitly sent to each existing QA
conversation. This isolates native transport from agent-generation/handoff logic;
it does **not** prove the agent handoff fix.

| Provider | Observed outcome |
| --- | --- |
| Discord | Cat rendered in the native media viewer; text file rendered with its exact contents. Image message `1546531868575535114`; file message `1546531871523995698`, in thread `1546513811672932372`. |
| Slack | Bot image loaded at 1024×1024 and text file preview contained the exact fixture contents in the existing CHA-6 thread. |
| Telegram | Bot image loaded at 800×800; document message `417200359:11` downloaded through the actual UI. The downloaded 128-byte file matched the source SHA-256 exactly. |
| GitHub | App comment transport is link-only for attachments; direct upload is not qualified. Live Board file send published a caption and one explicit private-task notice per selected file, starting with comment `5572594232`. No file bytes or loopback URLs were exposed. The misleading generic `Shared filename` preface was replaced and the final live retake verified the neutral wording below. |
| Teams | No live media claim: Microsoft 365 tenant/admin setup remains unavailable. |

Text fixture SHA-256:
`fd40030afb62b83181a2a46dde8220e8defecfa0b4328e380c30b1899ccdce24`.
Telegram's browser download event timed out, but the host download appeared in
Downloads at 09:46:27 local time and its size/hash verified successfully. This was
a browser event-observation limitation, not a failed file delivery.

## Inbound inspection checks

Files were uploaded through each provider's real message composer. The bot was
asked to inspect actual bytes, not infer content from filenames.

- Slack: run `10aa0f41-0cc3-4997-95b4-f50eb1e033e8` succeeded, identifying the orange
  tabby/green eyes and reading `cobalt otter 47.`. Both stored attachments were
  bound to inbound comment `cfb14fe0-f463-4952-9cf9-2acdc32997b2`. Final bot message
  `1788792053.513999` is in root thread `1788789960.341109` in `C0BUT55N9RV`.
  The run took about 135 seconds; this remains a usability concern.
- Telegram photo: run `03f06e17-a0e5-43e5-a894-0cea68566aa3` identified the cat,
  eyes/nose, sofa, plant and window from the inbound JPEG. Final message
  `417200359:6`; about 132 seconds.
- Telegram document: a follow-up sent while the image run was active queued and
  then ran as `41215211-debf-44cc-9b93-a220fd0931de`. It returned the exact phrase
  in `417200359:8`; about 81 seconds after execution began. The two messages stayed
  on CHA-8 and produced separate, correctly ordered responses.
- GitHub private issue upload: native UI produced an HTML image plus a Markdown
  text-file link. Human comment `5572301393`, bot `5572302077`, run
  `0c252a02-51cc-4aeb-b829-73865415070e`. The bot did not claim to inspect unavailable
  bytes, but described the active chat connection as unavailable and requested
  a separate tool connection. This is **not** a successful inbound media check;
  chat transport must explain its file/link limitations clearly.
- Discord: run `888e586d-b62e-454c-bb77-d4d0c14ea245` inspected both inbound files,
  identified the cat/green eyes/sofa/plant, and read the exact phrase. Final bot
  message `1546532360630177873`, about 146 seconds after execution began.

## Normal agent handoff retake

After restarting the local server with the handoff fix at 14:56:49 UTC, each
existing provider conversation received an ordinary request to return the cat
and create a text file with a provider-specific exact marker. The requests did
not tell Maya which tool or helper command to use. All three stayed on their
existing task, succeeded, and published both selected attachments.

| Provider | Run and real-provider proof |
| --- | --- |
| Discord | Run `448779d2-73a3-4f39-9f75-0c9fdac528d0`, 14:57:10–15:02:43 UTC. Native image message `1546536207448547401` loaded; native file `1546536210195808318` previewed exactly `DISCORD-FILE-HANDOFF-0907-OK`. |
| Slack | Run `d4b00e25-a2b6-49bd-9442-384419c88776`, 14:57:17–15:02:00 UTC. Both native files appeared in CHA-6's original thread; the image loaded at 1024×1024 and the file preview showed `SLACK-FILE-HANDOFF-0907-OK`. |
| Telegram | Run `949a2b1a-5f6c-4680-971c-cceb244be8a5`, 14:57:23–15:02:24 UTC. Image `417200359:14` loaded at 800×800. Document `417200359:15` downloaded through Telegram's real UI; its 29 bytes were exactly `TELEGRAM-FILE-HANDOFF-0907-OK`, without a trailing newline. |

The Telegram download SHA-256 was
`a0692bcddade1e6e9e1a15ee975c2c2d501be8bdc34c5e1cbe84b3de4e7b2f7f`.
Paperclip's outbox independently showed all six attachment publications as
`published`, one image and one file per provider, with no duplicate file sends.
The final prose said the files were **prepared**, not falsely provider-confirmed.

This repairs the reported missing-image failure, but the 283–333 second agent
turns are too slow for a polished simple file reply. The Discord run made 28
completed/failed tool calls, including avoidable connection discovery. The task
prompt now explicitly directs external file replies to the installed artifact
helper and away from provider-tool discovery or fetching a CLI. The final retake
below measures the improvement; native delivery success does not prove the
interaction is fast enough.

The Paperclip task transcript also passed a live UI check: inbound images and
files appeared even when the comment had no Markdown reference, the image opened
in the gallery at full size, and the text-file link opened its exact content.

## Implemented hardening

- Render provider-bound comment images/files in the task transcript, even when
  its caption contains no Markdown attachment reference.
- Include bounded, task/comment-scoped attachment descriptors in wake context so
  agents can discover and download the files without searching the whole task.
- Carry only explicitly selected same-agent/same-run attachments into final chat
  delivery. Never infer authorization from an unbound artifact alone.
- Explain GitHub's link-only behavior before an explicit Board file send and in
  the provider fallback. Do not expose loopback URLs or publish private files to
  an unrelated public upload service.
- Record immutable originating-run attribution on upload; never derive authority
  from editable work-product records or backfill ambiguous legacy files.
- Serialize both comment binding and direct-to-comment uploads. Reject a
  twenty-first chat file with an actionable error rather than silently dropping
  one; preserve ordinary non-chat multi-comment uploads.
- Recover matching uploads using immutable origin and exact content hash. Local
  concurrent helpers serialize; ambiguous network/408/5xx/malformed-success
  outcomes fail closed until the durable attachment is found or an operator
  explicitly accepts duplicate risk. This is not cross-host exactly-once upload.
- Post a single generation-fenced notice after a definite supported-provider
  file rejection, without replaying an ambiguously delivered file.

## Automated checkpoint before upstream reconciliation

- Fresh database chat integration: **262/262**, no skips.
- Focused server provider/projection/attachment tests: **313/313**.
- Executable artifact helper retry/concurrency tests: **18/18**.
- Focused UI tests: **120/120**; deterministic provider browser flows: **5/5**.
- Recovery/status/context checkpoint: **153/153**, using an explicit fresh
  PostgreSQL database instead of silently skipping unsupported embedded tests.
- Attachment wake-context scope/quarantine database checks: **6/6**, no skips.
- Migration snapshot drift: **1/1**. Workspace typecheck, workspace build, and
  UI token gates passed. These build checks precede the final provenance edits;
  final targeted compile is repeated before handoff.

## Final merged-build retake

Merged `origin/master` at `f6a211479`, retained the media hardening, and corrected
the connection wizard's tool-method selector after reconciliation. Restarted the
live server with migration 0249 applied. Three ordinary requests were sent from
the signed-in provider composers at 15:30:25–27 UTC, without helper instructions.

| Provider | Observed result on the final media implementation |
| --- | --- |
| Discord | Run `15f7af18-d052-44d3-9698-127433b9e941` succeeded in 163 seconds. Native image `1546543862883946597` visibly rendered the cat; file `1546543864142102529` previewed `DISCORD-MEDIA-FINAL-0907-OK`. |
| Slack | Run `d5e7b996-1fc0-41e4-92fd-c5522fd23fbb` succeeded in 183 seconds. Native file message `1788795212.198169` previewed `SLACK-MEDIA-FINAL-0907-OK`; image message `1788795215.443269` visibly rendered the cat in the same thread. |
| Telegram | Run `783a9af6-eefd-4d24-a39b-ce8eac97bdcf` succeeded in 151 seconds. Photo `417200359:18` loaded at 800 pixels wide; document `417200359:19` downloaded through the real UI. |
| GitHub | Fresh Board file send `4a82fa40-5fc0-42f7-99ac-ddc97c5b2ff8` produced comment `5572840135`: the file is saved on the private Paperclip task and this GitHub App connection cannot upload file bytes into comments. No misleading “Shared” preface or public file URL. |

All six native attachment publications were `published` with one attempt each;
each upload carried the correct immutable originating run. The refreshed
Paperclip task transcript showed the newly bound images/files, and the native
provider threads showed one copy of each selected file. GitHub's first fallback
retake attempted to reuse already comment-bound attachment IDs and correctly
received 409; a fresh QA upload was used instead, not a forced rebinding.

The downloaded Telegram file was 29 bytes with SHA-256
`464d31c3110370919f443cfb3576b836812f8590dd3bbf8572352d2cf4ed3136`, exactly matching
Paperclip's stored asset. It contained the requested marker **plus a trailing
newline**. The transport preserved the bytes correctly, but this is not an
exact-byte content-generation success. Discord's text also included a newline;
Slack's 25-byte marker had none. Do not silently rewrite generated file bytes in
the transport to hide a model-content mismatch.

Functional delivery is repaired. The 151–183 second turns improved substantially
from 283–333 seconds, but remain too slow for a polished simple file reply.
GitHub private inbound attachment bytes remain unqualified and the current
outbound adapter remains link-only. Teams remains live-unqualified without the
Microsoft 365 tenant/admin setup; no universal “files work everywhere” claim.

Post-merge verification:

- Connection/GitHub/tool-access/migration regression slice: **387/387**, no skips.
- Workspace typecheck and workspace build: passed on the final merged sources.
- Deterministic provider browser flows: **5/5** on another fresh database.
- UI token gates and `git diff --check`: passed.
- Native-session and adapter-registry tests: **158/158**.

Runtime reproducibility caveat: these live Maya retakes used the retained ACP
installation resolving Codex 0.148.0 with the Sol fixture model. The merged
manifest now requests 0.153.4, also installed as the global CLI. The local
dependency tree was not re-resolved during handoff, because doing so without the
CI-owned lockfile would also refresh ranged transitive dependencies and change
the just-qualified environment. Neither the lockfile nor Maya's model/engine
was modified. The next normal dependency refresh must requalify the current
runtime; these results do not establish that 0.153.4 ACP combination.

The broad workspace run was stopped after fixture/mock failures and does not
have a passing final summary. It also overlapped upstream reconciliation, so it
is not a valid final-tree checkpoint. Only the explicit focused runs above are
claimed green.

GitHub's [issue-comment REST API](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
accepts a comment body, unlike the browser's separate
[file attachment workflow](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files).
The shipped adapter's link-only behavior is a scoped product limitation; it is
not evidence that every possible GitHub integration can never transfer files.
