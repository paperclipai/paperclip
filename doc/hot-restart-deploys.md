# Hot-restart deploys

How a server restart or deploy keeps runs and the UI alive, and how to recover a blocked deploy.

During a restart, the UI's connectivity store (`ui/src/lib/connectivity.ts`)
confirms an outage with a `/api/health` probe, then polls health with backoff
(1s, 2s, 5s, 10s, then every 15s; a longer `Retry-After` wins). While the server
is unreachable, React Query pauses reads and `meta.replay = "idempotent"`
mutations instead of failing them; on recovery they resume and live queries
refresh once. Other mutations fail fast with readable copy and are not replayed.
Transient errors (network drops, non-JSON responses, 408/425/429/502/503/504,
and gateway codes such as `tenant_app_unavailable` in any status) are classified
in `ui/src/api/errors.ts`.

A new page shows **Reconnecting to Paperclip** with a **Try again** action and
waits for startup health to become ready. Valid startup metadata remains
available to sign-in and invitation pages. An already open page stays mounted
during temporary background failures so unsaved edits survive; after about two
seconds of continuous trouble, one app-level **Connection interrupted** banner
appears, followed briefly by **Back online**. Recovery does not reload the
browser. Authorization failures still require sign-in or an explicit retry.
Storybook **App / Connection recovery** shows the startup screens and banner.

Writes keep the user's text through an outage:

- Comments, new tasks, and board sends store the request and its key
  (`clientRequestId` or `idempotencyKey`) before they send
  (`ui/src/lib/pending-send.ts`, `ui/src/hooks/useDurableSubmit.ts`). After a
  transient failure or a lost response, the composer shows **Sending when
  reconnected…** with **Resend now** and **Cancel**, and resends with the same
  key on recovery. The server dedupes by that key. Restored board publications
  wait for an explicit retry. Restored plain comments and keyed requests resend
  after their initial backoff. A combined comment that also reassigns, reopens,
  or changes run settings waits for a matching server receipt or Cancel: comment
  deduplication alone cannot safely replay those task changes. Cancel returns
  the text for a fresh, intentional send. A new task restored without its staged
  files is not sent; the dialog asks for the files again. Restored subtasks keep
  their saved parent and goal defaults even when reopened from the normal New
  Task action. Successful staged-file
  uploads are identified by content digest as well as metadata, so distinct files
  with identical names, sizes and timestamps are both uploaded. Without browser
  hashing support, uploads proceed without receipt-based deduplication.
- Document and inline-editor autosave (`ui/src/hooks/useDurableAutosave.ts`)
  keeps unsaved edits in browser storage, shows **Will save when reconnected**,
  and saves the newest draft for each task or document on recovery. A `409`
  whose server copy equals the draft counts as saved. A temporary failure of
  that verification stays pending. Exhausted attempts show a manual retry action.
  Admitted edits can finish after route navigation unmounts the editor. That
  work waits for recovery events while offline, uses bounded backoff while
  online, and verifies the current account before each retry. The latest admitted
  save is shared by account and target across editor mounts, so a superseded
  detached retry cannot overwrite a newer edit after reopening the same task.
  Replayable task-field updates and interaction resolutions bind the original
  account, account generation and operation at dispatch. A sign-out or account
  change cancels that intent before it can send, including after waiting behind
  another write; callbacks cannot apply an old result to the next account.
  Stored document drafts and mounted editors belong to the signed-in user.
  Storage failure shows a warning to keep the tab open or copy the text.
- Issue field updates go through `useUpdateIssueMutation`: optimistic, rolled
  back with readable copy on failure, and replayed on reconnect for absolute
  fields. Updates run in order, so an older update that retries cannot
  overwrite a newer one.
- Uploads and other non-idempotent requests never resend on their own; they
  keep the input and offer **Retry**.

The banner counts every write that waits for the connection.

To reproduce a deploy blip in a dev or QA build, set the outage simulator in the
browser console and remove it to end the outage:

```js
localStorage.paperclipSimulateOutage = "503:tenant_app_unavailable"    // until removed
localStorage.paperclipSimulateOutage = "503:tenant_app_unavailable@20" // for 20 seconds
localStorage.paperclipSimulateOutage = "network"                       // dropped connection
localStorage.removeItem("paperclipSimulateOutage")
```

Reads render through `useQueryView(query)` or `<QueryView>`
(`ui/src/components/QueryView.tsx`). The view state is one of `loading`,
`ready`, `stale` (data plus a transient failure: render the data, no red
text), `reconnecting` (no data yet while the app-wide connectivity state is
not `online`: a quiet placeholder that fills in by itself when the probe loop
recovers), or `error` (a real failure: `describeError` copy with a Retry
button). A transient failure with no data while the server is reachable (a
429, one plugin worker restarting, a 504 on one slow route) is also `error`
once the retry policy gives up, because no recovery loop would refetch it.
"Not found" renders only when `classifyError` says `not_found`, never for an
outage. `<QueryErrorState>` is the error presentation on its own, in `page`,
`panel`, and `inline` sizes. Plugin chrome (`usePluginSlots`,
`usePluginLaunchers`) is the one exception: it never reports a transient
failure and stays collapsed instead.

`node scripts/check-query-error-rendering.mjs --summary` reports UI code that renders raw query errors
(`{error.message}`, `isError ?`) or sets `retry: false`. It is report-only for
the long tail; pass `--enforce` to fail on every finding. Files listed in
`ENFORCED_FILES` in the script have already migrated, and a finding in one of
them fails the check in every mode. Add a file to that list when you migrate
it. For an intentional exception (a mutation result rendered inline, a
prop that is already outage-aware), end the line with `// query-error-ok:
<reason>`. Reads that must fail fast use `retry: retryTransientOnly(0)`
instead of `retry: false`.

Primary-instance rebuilds that restart `paperclip.service` can request one-shot live-run adoption instead of using the normal graceful shutdown drain. Before restarting the service, write the marker from the newly staged app with the current service PID:

```sh
old_main_pid="$(systemctl show paperclip.service -p MainPID --value)"
pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts --server-pid "$old_main_pid"
systemctl restart paperclip.service
```

The staged command records the target server's boot identity and operating
system process start time with the PID. It reads process metadata through
`/proc` on Linux, `ps` on macOS and BSD, and PowerShell on Windows. These
identities let a later request reclaim an abandoned marker after the operating
system recycles the numeric PID. Older markers stay compatible and use process
start metadata when available. When OS metadata is unavailable, the current
server's health-reported boot time can still prove that a legacy marker predates
the process now using its PID. Paperclip refuses to create a new request without
at least one identity source. Supported-platform process probes fail explicitly
instead of silently treating a live PID as either the original owner or a
recycled process when identity cannot be established.

Use `--drain-required` only when the deploy intentionally requires the old terminate-and-retry behavior. Without that flag, the old server verifies that the marker targets its own PID, stops new scheduler work, waits for any queue-claim callback already in flight, snapshots currently running heartbeat run IDs and child PIDs, and skips the shutdown drain so eligible detached local-agent processes can keep running. ACP-backed local runs use server-owned stdio and cannot survive their parent server, so the old server instead persists their complete snapshot, changes the marker to `drainRequired` with `drainReason: "active_acp_run"`, and drains only those runs to bounded conversation retries. These retries resume the prior session when compatible, otherwise carry the full task conversation into a fresh session. They do not automatically replay tool calls or require receipts for every prior action. Detached CLI runs remain eligible for adoption during the same mixed restart. If an ACP process terminates but its terminal run update does not persist, startup classifies it as lost with reason `selective_drain_not_finalized` rather than treating the drain as successful. On startup the new server writes `$PAPERCLIP_HOME/instances/${PAPERCLIP_INSTANCE_ID:-default}/hot-restart-report.json` with `previousServerPid`, `newServerPid`, `previousServerVersion`, `newServerVersion`, `drainReason`, `adoptedRunIds`, `finalizedWhileDownRunIds`, `lostRunIds`, and per-run classifications before the normal orphan reaper runs.

When Paperclip manages embedded PostgreSQL, it suppresses that dependency's eager
`SIGINT`/`SIGTERM` cleanup hooks. Paperclip owns signal ordering so the heartbeat
snapshot and any required drain complete while the database is still available;
the coordinated shutdown path stops embedded PostgreSQL afterward.

The request command records the preflight set of running heartbeat IDs and writes
an instance-scoped marker plus a PID-targeted legacy home-root handoff marker.
This lets a previous server version capture its snapshot at the old path while
the new server correlates that snapshot back to the authoritative instance
request. If any preflight run ID is absent from the shutdown snapshot, the
startup report includes it in `lostRunIds`; a missing snapshot therefore cannot
look like a zero-loss restart.

A healthy guarded deploy must compare the report against `/api/health` (`version` or `serverVersion`) and treat any `lostRunIds` entry as a continuity failure that needs recovery before marking deployment complete.

### Recovering a deploy blocked by missing process metadata

If the currently installed version already has a running local-agent heartbeat
whose `processPid` and `processGroupId` are both null, that pre-fix run cannot be
made adoptable retroactively. Cross that version boundary once with the normal
drain-and-retry path:

```sh
old_main_pid="$(systemctl show paperclip.service -p MainPID --value)"
pnpm --filter @paperclipai/server exec tsx ../scripts/request-hot-restart.ts \
  --server-pid "$old_main_pid" --drain-required
systemctl restart paperclip.service
```

After the fixed server starts, wait for the replacement `codex_local` heartbeat
to spawn, then confirm its run record has an identity (use an authenticated API
request in authenticated mode):

```sh
PAPERCLIP_API_BASE="${PAPERCLIP_API_URL:-http://127.0.0.1:3100}"
PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"
curl -fsS "$PAPERCLIP_API_BASE/api/heartbeat-runs/$RUN_ID" \
  | jq -e '.status == "running" and (.processPid != null or .processGroupId != null)'
```

The next continuity check should use the ordinary marker without
`--drain-required`. After restart, require both an empty loss list and an
explicit outcome for the run that was live before restart:

```sh
jq -e --arg run "$RUN_ID" \
  '(.lostRunIds | length) == 0 and ((.adoptedRunIds + .finalizedWhileDownRunIds) | index($run) != null)' \
  "$PAPERCLIP_HOME/hot-restart-report.json"
```

An alive child appears in `adoptedRunIds`; a child that completed during the
restart window appears in `finalizedWhileDownRunIds`. Either is continuous. A
`lostRunIds` entry remains a failed deploy and must not be waived.

For a recovery from a version that can stop embedded PostgreSQL before writing
its shutdown snapshot, use `--drain-required` once to cross the broken boundary.
After the fixed server is live, perform another ordinary hot restart. Require
`lostRunIds` to be empty and every preflight run to appear in either
`adoptedRunIds` or `finalizedWhileDownRunIds`; an ACP-backed original should be
finalized and have a queued retry rather than be adopted.

Tailscale/private-auth dev mode:

```sh
pnpm dev --bind lan
```

This runs dev as `authenticated/private` with a private-network bind preset.
On a fresh authenticated/private instance, open the app, sign in or create an
account, and use the setup screen to claim the first instance admin from the
browser. The CLI fallback remains:

```sh
pnpm paperclipai auth bootstrap-ceo
```

For Tailscale-only reachability on a detected tailnet address:

```sh
pnpm dev --bind tailnet
```

Legacy aliases still map to the old broad private-network behavior:

```sh
pnpm dev --tailscale-auth
pnpm dev --authenticated-private
```

Allow additional private hostnames (for example custom Tailscale hostnames):

```sh
npx paperclipai allowed-hostname dotta-macbook-pro
```
