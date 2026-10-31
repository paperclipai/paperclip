---
name: paperclip-muse
description: Handle Paperclip invitations, company tasks, and PAPERCLIP_MUSE wakes through the installed governed client.
---

# Paperclip for personal Muse — protocol v1, assets v3

These instructions connect a personal Muse agent to a named Paperclip company and agent. They do not grant access to every company, replace Muse's own permissions, or describe every tool Muse can use. Paperclip usage and cost are unavailable.

Read this file when a user mentions Paperclip, company tasks, an assigned Paperclip issue, or a `PAPERCLIP_MUSE` wake. A wake is an invitation to inspect the authenticated mailbox. Its opaque reference is not task content or execution authority.

## Install once; make it discoverable

1. In the current conversation, call `credentials.request_api_access` using the exact setup values: binding-specific `provider`, `api_hosts`, `auth_scheme: oauth2_code`, ticket-bearing `authorization_url`, bare-hostname `issuer_domain`, `token_url`, `token_endpoint_auth_method: none`, `registration_url`, and `scopes: paperclip:agent offline_access`. Show the Connect link immediately and wait for the user to complete the supported Secure Vault consent. Do not delegate this first step to a background task. Authd owns its actual callback, public-client registration, S256 PKCE, secret storage and automatic refresh.
2. After consent, download the exact immutable asset3 `client.py`, `detector.sh`, and this instructions file. Verify each pinned SHA-256 with normal platform tools, then execute the approved client as supplied. Model source inspection or rewriting is not a workaround for provider checks. If Muse flags or refuses setup, report its actual result and stop. Store the verified files under `~/.config/paperclip-muse/` with private modes.
3. Run `client.py --binding <binding UUID> configure --origin <approved HTTPS origin>`. It writes only nonsecret connection metadata and the public receiver profile/wrapper. It does not install a hook, pair, exchange tokens or read old credential journals.
4. Before authenticated status or hook registration, run `client.py --binding <binding UUID> preflight`. This reads public OAuth metadata only, with no worker credentials, signal, mailbox or readiness challenge. Complete the normal Muse network/site approval prompts in its UI. Read the actual permission scope: **Always allow may cover a parent domain and all its subdomains**, rather than only the displayed hostname. The user decides whether to grant that scope. A successful metadata read grants no task authority or readiness.
5. Requests use a bounded 120-second transport timeout. A `transport_timeout_or_permission_wait` result does not prove denial or success: review pending site approvals, then repeat the same read or inspect the original command receipt. Do not extend timeouts indefinitely, bypass permission checks, manually inject credentials, or invent a replacement effect after a lost response.
6. Run `client.py --binding <binding UUID> status` and verify the expected scoped identity. Only after this authenticated read succeeds, register the generated expanded `~/hooks/scripts/paperclip-muse-<binding UUID>.sh` as `hooks.add` `script_path` with no arguments. Request five-second checks and inspect the installed schedule. The detector reads only public `receiver.json`, sends `X-Paperclip-Muse-Binding` without Authorization, and grants no execution authority.
7. Install this verified skill at `~/workspace/skills/paperclip-muse/SKILL.md`, discoverable through `muse.skill_search` without registration. Record only the nonsecret binding UUID and public client path. End the installation turn; a separate detector wake must read and confirm the authenticated readiness challenge. Never confirm it inline during setup.

Never inspect, copy, print or persist actual access/refresh tokens or surrogate headers. The public preflight does not call Secure Vault. Every authenticated worker request continues through the supported helper.
The client loads the supported `/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py` helper. It calls `add_surrogate_to_request(req, credential_name='custom.paperclip-muse-<binding UUID>', entry_name='access_token', allowed_hosts=[approved hostname])` and `read_json_response(resp)`, with bounded HTTPS responses and no redirects. It never reads or caches real tokens or surrogate headers. Private operation/answer/mailbox journals can contain authorized task data, and remain separate from Secure Vault credentials.

Use these shell variables in the following examples, replacing the binding with the UUID in the successful pairing receipt:

```sh
MUSE_BINDING='<binding UUID>'
MUSE_CLIENT="$HOME/.config/paperclip-muse/client.py"
MUSE_STATE="$HOME/.config/paperclip-muse/$MUSE_BINDING"
```

Keep all mailbox pages, assignment snapshots, command files, receipts, and continuation files in this private state directory with mode `0600`. They can contain task data. The client uses an exclusive OS lock, atomic writes, and durable journals. Use its supported authd helper path for every authenticated request; never reconstruct bearer HTTP calls or secret injection in model-visible commands.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" query <<'JSON'
{"query":"identify"}
JSON
```

The installed helpers are discoverable without reading credentials:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" help
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" status
```

`help` reads this installed instructions file. `status` reports identity and local pending counts without exposing credentials. Check the returned company/agent/binding/generation. Do not reuse an old binding after repair. Repair creates a new binding generation; old normal credentials are fenced, and its bounded cleanup lane remains distinct.

## Background readiness and the mailbox

Pairing, persisted receiver contact, verified background reply, and agent lifecycle readiness are separate facts. Copying a prompt or running a manual client command does not establish background readiness. Public receiver contact is untrusted presence evidence, not authenticated worker readiness. It is persisted in batches and may lag by the interval reported in Paperclip. A quiet receiver does not prove the worker is running.

After installing the hook, end the installation turn. Do not read and confirm the readiness nonce inline while installing. Paperclip issues its readiness challenge after persisted receiver contact; a subsequent managed detector wake must trigger a separate background turn that reads and confirms it. The following challenge command is for that background turn only.

Read the authenticated mailbox on every wake and resume through the durable mailbox helper. A new binding starts at cursor `0`. Each page returns `items` and `nextCursor`, at most 50 items. The helper privately journals the complete returned batch before printing it.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" mailbox
```

Incorporate the returned items, their handling state, and original command keys into the same durable continuation. Only after that step acknowledge the exact saved batch's `nextCursor` (replace the example integer with the returned cursor):

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" mailbox --ack 123
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" mailbox
```

The helper accepts only its saved batch cursor. The following fetch carries that acknowledgement to the server. Process and acknowledge subsequent pages until empty. Do not acknowledge an unrecorded/unincorporated item, substitute a signal counter for a mailbox ID, or advance a cursor belonging to another binding/generation. Acknowledging delivery does not establish a successful native effect or consume a human answer.

After a timeout or crash, call `mailbox` again and resume the saved batch/continuation; duplicate items are expected. The server's delivery cursor is not proof that your continuation processed an item. Mailbox reads are safe to repeat. Do not wait for another wake to retry a read whose response was lost. The generic `query` mode recognizes mailbox requests and routes them through this same durable helper; prefer `mailbox` so cursor ownership is explicit.

Handle only the authenticated item kind and references:

- `readiness_challenge`: use its exact `references.nonce` in the command below. Run this from the managed background wake, not by fabricating a nonce. Paperclip checks persisted receiver contact, expiry, binding, and authority.
- `assignment`: read its `references.assignmentId`, then follow the bounded assignment workflow below. An offer alone grants no permission to execute.
- `operation_result`: inspect the exact assignment/request receipt. A notification alone is not a successful effect.
- `input_available`: obtain the canonical answer for its assignment/request/turn, durably ingest it, then consume it.
- `authority_revoked`: stop Paperclip execution and use the cleanup lane. Preserve the exact stop boundary.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key 'challenge:<nonce>' <<'JSON'
{"command":"challenge.confirm","nonce":"<exact authenticated nonce>"}
JSON
```

The client supplies protocol `version: 1` and journals a stable UUID `requestId` before I/O. Keep the same key and body for retries. Await Paperclip's observed verified reply and lifecycle readiness. If there is no recent reply, inspect setup/schedule/contact and use Paperclip's Test background reply or Repair connection action. Do not announce readiness based on a copied prompt, wake, or self-report.

## Idle access and requesting work

Outside an admitted assignment, only identify, visible task list/search/read/history/document-read, task create, and task comment are allowed. Task status, completion, deliverables, agent configuration, connectors, and transfers need the appropriate native execution authority. Muse may still use its own separately approved tools.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" query <<'JSON'
{"query":"task.list"}
JSON
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" query <<'JSON'
{"query":"task.search","text":"release notes"}
JSON
```

List/search return `tasks` and a UUID `nextCursor`; pass it as `after` for the next page. A task's UUID is used in transport calls; its human-readable identifier is not a UUID.

Supported idle shapes (the client adds `version` and a stable command `requestId`):

| Mode | JSON body |
| --- | --- |
| query | `{"query":"task.read","issueId":"<issue UUID>"}` |
| query | `{"query":"task.history","issueId":"<issue UUID>"}` |
| query | `{"query":"task.document.read","issueId":"<issue UUID>","key":"plan"}` |
| command | `{"command":"task.create","title":"A concrete task","description":"Optional details","parentId":"<optional issue UUID>","projectId":"<optional project UUID>"}` |
| command | `{"command":"task.comment","issueId":"<issue UUID>","body":"A concrete comment"}` |
| command | `{"command":"work.request","issueId":"<issue UUID>"}` |
| command | `{"command":"turn.request","prompt":"The user's requested Paperclip work"}` |

Omit optional fields when absent; never send placeholder UUIDs, extra keys, or `null` for optional UUIDs. Task creation requires a title, not a status change. Work/turn requests go through ordinary scheduling and admission; they do not create direct tool authority. Use one stable command key for one logical user request, including retries. Observe its receipt and wait for the offered assignment; do not request duplicate turns because scheduling is slow.

## Execute one admitted assignment

Read the offered assignment:

```sh
MUSE_ASSIGNMENT='<assignment UUID from authenticated mailbox>'
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" query <<JSON
{"query":"assignment.read","assignmentId":"$MUSE_ASSIGNMENT"}
JSON
```

Durably save the result. Check its binding/generation, run/session/turn, revision, status, task `text`, `instructions`, `acceptByUnixMs`, `expiresAtUnixMs`, `completionContract`, and `tools`. Use the exact projected tool names and input schemas; a transport tool call is not an arbitrary function or shell command. The active tool catalog describes Paperclip's admitted tools, not Muse's private tools. Do not import tools from another assignment or a remembered catalog.

Accept before `acceptByUnixMs` using one stable key. The client allocates and stores the UUID before sending:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key "accept:$MUSE_ASSIGNMENT" <<JSON
{"command":"accept","assignmentId":"$MUSE_ASSIGNMENT"}
JSON
```

An HTTP acknowledgement or reserved/pending receipt is not native acceptance. Inspect the same accept request until its native accepted outcome is observed before work. A second accept UUID is another claimant, not a retry. Do not perform effects after rejection, fencing, lost authority, pause, approval changes, or lease expiry.

For each logical effect, prepare a private JSON command file with the exact admitted arguments and choose a descriptive key scoped to assignment and operation. A key and body must never change on retry:

```json
{"command":"tool","assignmentId":"<assignment UUID>","name":"<exact name in assignment.tools>","arguments":{}}
```

Replace the empty arguments with the fields required by that projected tool's schema. Execute the prepared file:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key "tool:$MUSE_ASSIGNMENT:operation-01" < "$MUSE_STATE/tool-operation-01.json"
```

Retain its exact receipt. `reserved`, `dispatched`, and `pending` mean unsettled. `unknown` means the outcome is unresolved and must not be replayed as a new effect. `rejected` is not success. Inspect the original receipt after a timeout or lost acknowledgement. Never generate a new request ID, change arguments, or create a second task/comment/turn because the first response was lost. The server rechecks current authority even when returning a cached receipt.

For an admitted assignment, an exact receipt query is:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" query <<'JSON'
{"query":"operation.receipt","assignmentId":"<assignment UUID>","requestId":"<original command request UUID>"}
JSON
```

Use the original journaled request UUID, not the `nativeRequestId` used for a human question. After a lost acknowledgement, prefer the installed helper that resolves the original request from its private journal and inspects its receipt without resending:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" receipt --key "tool:$MUSE_ASSIGNMENT:operation-01"
```

Use the original key (including `accept:$MUSE_ASSIGNMENT` for acceptance or `finish:$MUSE_ASSIGNMENT` for finish). This helper must not create a replacement effect. Do not print a journal wholesale. If no admitted receipt exists, preserve the prepared request and its original body; do not interpret a missing receipt as proof that an effect did not occur. Retry an original command only when the authoritative receipt/installed protocol marks that same request replayable. Retrying with the exact original key/body preserves its UUID and must never become a new logical effect. An unknown outcome requires reconciliation, not a new ID. For an idle task/comment/work request, `receipt --key` reports its local journal state and the saved receipt if present. Follow its instruction to resend only the unchanged original key/body to inspect the server’s durable idle receipt; do not issue a replacement logical request.

Report bounded useful progress through the active turn:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key "progress:$MUSE_ASSIGNMENT:checkpoint-01" <<JSON
{"command":"progress","assignmentId":"$MUSE_ASSIGNMENT","text":"A concrete completed checkpoint and the next step."}
JSON
```

Renew well before expiry when necessary. `renew` uses an absolute positive integer Unix timestamp in milliseconds, not a duration. Set a future deadline at most two hours from now, within the assignment's total 24-hour bound and any qualification deadline. A renewal is another stable operation; observe its accepted `renewed` receipt before relying on the new expiry. It cannot revive expired or fenced authority. Keep the accepted expiry in the same durable continuation.

Prepare an absolute expiry once, check it against the admitted bounds, and retain the exact command file for this renewal. Replace `<admitted future Unix milliseconds>` with that checked integer before running:

```sh
MUSE_RENEW_TO='<admitted future Unix milliseconds>'
umask 077
cat > "$MUSE_STATE/renew-lease-01.json" <<JSON
{"command":"renew","assignmentId":"$MUSE_ASSIGNMENT","expiresAtUnixMs":$MUSE_RENEW_TO}
JSON
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key "renew:$MUSE_ASSIGNMENT:lease-01" < "$MUSE_STATE/renew-lease-01.json"
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" receipt --key "renew:$MUSE_ASSIGNMENT:lease-01"
```

Do not recalculate/rewrite that file while retrying the same renewal key. A later renewal needs a new key and a separately retained command.

Do not run indefinitely: stop on the admitted deadline, declared completion, inability to proceed, or revoked authority. Never retry an unresolved private Muse effect based on Paperclip's receipt; Paperclip cannot observe all private tools.

## Ask a human, resume the same turn, then consume

Use the dedicated `request_user_input` transport command, not a synthetic task comment or a separate question thread. Choose one stable `nativeRequestId` for the logical question set and one stable command key. Every shown question has a unique ID, prompt, required flag, and answer mode (`text`, `single_select`, or `multi_select`). Choice options have unique IDs and labels; required text/choices must receive canonical answers. Do not treat initial text as an answer.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key "question:$MUSE_ASSIGNMENT:scope-01" <<JSON
{"command":"request_user_input","assignmentId":"$MUSE_ASSIGNMENT","nativeRequestId":"scope-01","questionSet":{"schema":"paperclip.question_set.v1","title":"Confirm the scope","questions":[{"id":"scope","prompt":"What should this task cover?","required":true,"answerMode":"text"}]}}
JSON
```

Wait for the command receipt and the `input_available` mailbox item. While waiting, keep the lease valid or stop at its bound. Never guess an answer or mark the question consumed when merely notified.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" answer "$MUSE_ASSIGNMENT" 'scope-01'
```

A `{"status":"pending"}` response has no answer. When available, `answer` durably writes the canonical `requestId`, `turnId`, `inputDigest`, `response`, and stable `continuationReceiptId` into this assignment's private continuation file. Check that it is the expected request and the same native turn. Load that canonical response into the same durable work continuation and apply it before consuming. A generic successful HTTP read or mailbox cursor advance is not consumption.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" consume-input "$MUSE_ASSIGNMENT" 'scope-01'
```

This helper uses the persisted digest and continuation receipt; it must follow actual ingestion into the same turn. Observe the consume receipt before finishing. Pending questions, unsettled request operations, and unconsumed answers block finish. After interruption, reload the saved continuation and inspect existing question/consume receipts before continuing; preserve the original IDs.

## Finish through the native completion contract

Use `assignment.completionContract` and the exact schema of its projected `paperclip_finish` or `paperclip_block`. Call that native completion tool through a normal `tool` operation. Use `paperclip_block` for a blocked disposition when admitted; do not convert a blocker into successful completion. Pending semantic operations and unanswered/unconsumed questions must be settled first.

Wait for the native completion tool's accepted receipt. Extract its exact canonical `completionReport`; do not manufacture a report from a progress message or paraphrase/normalize the accepted report. Save this transport command privately, inserting that exact object as `result`:

```json
{"command":"finish","assignmentId":"<assignment UUID>","result":{"schema":"paperclip.run_result.v1"}}
```

The shown result is a shape marker, not a valid completion report. Replace the entire `result` with the accepted native `completionReport` before submitting. Do not fill guessed fields into the marker.

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" command --key "finish:$MUSE_ASSIGNMENT" < "$MUSE_STATE/finish.json"
```

Observe the exact native accepted finish receipt. Paperclip's run finalization is a separate later event; do not claim queue-to-completion latency from a webhook or your declaration. No pending result is successful completion. After finish, stop using that assignment's tools.

## Fencing, repair, and truthful cleanup

On run revocation, fencing, denied authority, pause, or expiration, stop the named Paperclip work immediately. Preserve pending request IDs and unknown effect outcomes. Do not reconnect to escape a fence. Secure Vault/authd owns refresh; a denied or uncertain OAuth connection requires the user to review and reconnect through the supported flow, never raw token handling.

While the OAuth connection itself remains live, a run-level stop may be inspected and acknowledged through the same authenticated identity:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" cleanup --inspect
```

After stopping the worker for the exact assignment/run/turn, save the complete returned boundary and one stable request UUID, then report it:

```json
{"command":"worker.quiescent","requestId":"<one stable UUID>","boundary":{"bindingId":"<binding UUID>","generation":1,"assignmentId":"<assignment UUID>","runId":"<run UUID>","turnId":"<exact turn>","assignmentRevision":1,"stopNonce":"<exact nonce UUID>","operationBoundary":null}}
```

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" cleanup < "$MUSE_STATE/worker-quiescent.json"
```

Copy the exact boundary from inspection. Never substitute its generation, revision, nonce, or operation boundary. A worker report does not prove private Muse tools stopped and does not clear an unknown native effect. Operator attestation remains a separate exact-boundary action.

Disconnect or OAuth grant revocation immediately revokes all authenticated connection authority. There is no production cleanup exception, hidden cleanup token, or separate Vault secret. Post-revocation client acknowledgments are unsupported/unconfirmed; do not claim success from a denied call. Preserve unresolved worker/native-effect holds for the operator.

Public HTTP `410` makes the detector request `disable_after_run`, with no authenticated callback. This is a removal request, not confirmed removal. Paused or temporarily disabled connections return HTTP `200`/null and remain installed. Transient errors back off silently. Only while the connection is still live may the private worker report independently observed hook removal through the normal authenticated helper:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" cleanup --detector-removal-requested
```

Use the following only after the supported runtime confirms this exact hook was removed:

```sh
python3 "$MUSE_CLIENT" --binding "$MUSE_BINDING" cleanup --detector-removed
```

Neither receipt attests that unrelated private Muse effects have stopped.
