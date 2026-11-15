# Board UI internals

Browser-side behavior: the saved read cache, write and connection recovery, startup, and bundled fonts.

## UI Fonts And Screenshots

The board UI ships its own sans-serif webfont assets in `ui/public/fonts/`.
`ui/src/index.css` declares Inter v4.1 variable regular and italic faces and wires
the Tailwind `font-sans` token to those bundled files before system fallbacks.
Linux screenshot or Storybook capture jobs should not install host Inter packages
or inject external font CSS to make Paperclip text render correctly.

Font assets live in Vite's public directory so `pnpm --filter @paperclipai/ui build`
emits them under `ui/dist/fonts/`. The server package copies the same output into
`server/ui-dist/fonts/` through `scripts/prepare-server-ui-dist.sh`.

## Recent task ordering

The streamlined sidebar keeps five recent tasks per company and account in browser
storage. It sorts by the newest observed task or comment activity, not by live-run
state. Older detail responses cannot move the stored activity time backward.
Activity-only reorderings wait for one second without further activity changes;
new and removed tasks appear immediately. Titles, status, and live indicators stay
current during that delay.

The sidebar renders saved snapshots immediately and refreshes its exact five IDs
with one company/account-scoped summary query. Passive refreshes do not fetch
full task details or inspect workspaces. Successful omissions remove unavailable
tasks; failed batch reads retain saved history. Existing full-detail cache data
can update an entry only after the current account's summary confirms access.
The first healthy live subscription reconciles domain data without re-fetching
session and health; reconnects and visibility recovery retain full reconciliation.

## Authenticated board startup

`GET /api/auth/get-session` can include an optional `boardBootstrap` for the same
authenticated session or Cloud tenant actor. It contains accessible company
snapshots and the existing current-board-access projection. Directory visibility
through instance admin alone does not add accessible companies. The ordinary
session schema stays compatible with clients that ignore this projection.

The browser seeds account-keyed navigation and board-access queries from this
response, avoiding two serial startup reads. Normal company/access readers still
own invalidation and refresh. A new successful session snapshot replaces older
cached membership/access for a returning account once; later ordinary reads and
mutations can update those queries. Missing, malformed, or failed optional bootstrap
falls back to those readers; a failed session does not become an anonymous cache
entry. Local trusted startup keeps its existing synthetic `local-board` principal.

## Browser write recovery

Use `useDurableAutosave` for replayable field updates and `useDurableSubmit` for
user submissions that have an idempotent server contract. Bind queued jobs to
the original task and save callback. A task switch must not retarget pending work.
Keep the original creation key when a restored draft needs its attachments again;
attachment selection order does not create a new request. Document and decision
writes with an uncertain response verify the saved result before reporting failure.
Verification reads can themselves need retry. Conflicts and permanent failures
must reach the caller. Once automatic attempts stop, show **Resend now** instead
of promising another automatic attempt. See the hook, document, task creation and
connected-task banner tests for these contracts.

Inline editors preserve typing through the first owner lookup and remount after
a known draft owner changes. Connected-channel sends use
account-scoped storage and publication queries; retries and receipts retain the
original account generation. Returning to that account restores its saved send
for an explicit same-key retry. Earlier unowned channel receipts are preserved
without revealing or replaying their text. They require inspecting Activity
before a new send because their original sender cannot be established safely.
After checking Activity, a person can explicitly discard the unowned browser
record to start a fresh update. This never replays the old text or cancels an
already accepted publication; storage failures keep the hold in place.

Task-creation drafts and recovery state are account-scoped. A known account
change remounts the dialog, clears staged in-memory files and stops old creates
before any subsequent upload. An interrupted account-bound request stays pending
under its original key; it is never relabelled as a provider refusal. Legacy
unowned form drafts remain in browser storage but are not restored into another
account. Storybook fixtures seed the same account-specific keys.

New-task submissions use `useBackgroundSubmitQueue` around `useDurableSubmit`.
The account-scoped queue retains each request's original key and draft snapshot
before the composer closes. The worker sends requests in order. A request with an
uncertain receipt retains its key; a rejection restores the submitted draft or
offers a retry beside a newer draft. Submitted files use separate IndexedDB keys
for the account, company, and request, so finishing an older save cannot remove
newer files. Each submitted request has its own local-storage entry. A write or
receipt in one tab cannot replace another tab's queued requests. Legacy queue
arrays migrate to separate entries before the shared array is removed. Legacy
single-request recovery records remain readable.

New-task staged file bytes are stored in IndexedDB for the account and company.
Writes merge the selected files with the current saved list in one read/write
transaction. Removal and successful creation delete only the files that the
mounted draft removed. Other open tabs keep their saved files across reloads.

Successful pending-record writes have the same readable size range as browser
storage. In particular, a large task description cannot silently drop its
creation key on reload. Reselected text documents recover their original
file-to-document-key mapping before fingerprint comparison and upload.
Document editors remount on subject changes, and a message attempt settles only
once when a server receipt races its HTTP retry. Startup autosaves bind to the
first resolved account; a later known-account change still cancels old work.
Account-bound status changes and decisions also wait for the first lookup rather
than rejecting an action made while it loads. Waiting work starts a bounded retry
of a failed session lookup; exhaustion reaches the original error callback instead
of leaving the operation pending. Removing that session scope cancels its lookup
work. Account cancellation after an uncertain POST keeps the original request key.
Comment retries check the original
account generation at the click and again immediately before their POST, including
after optimistic cache cancellation or conversation creation. A retained accepted
comment returns its existing receipt before the route can reopen a completed task.
`server/src/services/issue-comment-receipt.ts` completes reference and activity
records for keyed board comments. It locks the same-company task before its
comment, matching task and company deletion, comment removal and tombstoning. It repairs references and
inserts a missing activity record in one
transaction, and publishes after commit. The task uses `FOR NO KEY UPDATE` so
concurrent comments can reference each other without blocking foreign-key checks. Both the initial send and a retained
receipt use this owner so concurrent completion cannot duplicate the activity.
Large comment request records use the same readable range as successful writes,
including JSON-escaped bodies. Account changes retire only the original optimistic
echo and cannot apply its rollback to the next account.

## Browser realtime connection recovery

If a browser cannot construct a WebSocket, the live-update and run transcript
clients use their disconnected retry paths. While the company event stream is
disconnected, visible active queries refresh every 15 seconds. This fallback
stops when the socket opens, the tab is hidden, or the provider unmounts. A
reconnected socket also refreshes visible queries to recover missed events.
Run log views retain their existing HTTP polling fallback.

## Company context during hot reload

The company React context retains only its object identity in Vite's per-module
`hot.data`. Provider values remain in the mounted React tree and keep their normal
account scope. This lets a refreshed consumer read a provider from the preceding
module version. Production builds do not use the development cache.

Run `pnpm test:e2e:browser-context` to test this with real Vite modules and
Chromium. The test starts its own loopback Vite server and mocks API responses;
it needs no running Paperclip instance or provider credentials. The same spec lives
in the default `test:e2e` discovery tree, so the existing Chrome CI shards run it
on pull requests.

## Read resilience during deploys

Read surfaces use `useQueryView` and `QueryErrorState`. Transient refetch failures keep loaded data visible. An initial outage keeps a quiet placeholder until recovery. Authorization, missing resources and validation failures still show readable errors. Exhausted first reads on a reachable server offer Retry, including task filters and hierarchy reads. Health probes and the socket own app-wide recovery; a successful component load may be an older in-flight response or a local no-op. Sensitive manual reads use `useResilientFetch`; browser viewer URLs and pairing previews remain in component memory and never enter a shared cache.

Run `node scripts/check-query-error-rendering.mjs`. The guard now enforces across `ui/src`, including multiline expressions, and CI runs it as a policy check. Its small allowlist covers standalone preview/performance fixtures, transcript protocol result flags, and the existing account-resolution and Copilot discovery retry owners. These are not ordinary read-error renders. Additions require a specific reason; do not allowlist a page to hide an outage regression.

The browser saves a small read cache in `paperclip:query-cache:v1:*` local storage records. It contains session display identity, health and shell preferences, company and sidebar data, agent/project lists, plugin UI contribution metadata, the first inbox page (including up to 100 rows per legacy Inbox query), and up to 20 recently opened tasks. Records belong to one user and company, expire 24 hours after each read, and are discarded when the build changes. Normal in-memory query garbage collection does not erase saved recent tasks or extend their expiry. Builds without a source commit stamp skip read-cache hydration and persistence, but still revoke and clear saved reads on sign-out. Plugin contributions use the existing instance-wide query inside the user's root record. Session tokens, bootstrap payloads, documents, comments, browser viewer capabilities, pairing data, other queries and mutations are excluded, with one exception for the saved recent tasks below. Task content in this allowlist remains on the browser until expiry or sign-out; use the normal sign-out action to clear it across tabs.

The first chat frame of each saved recent task is also saved, so a hard load of a task the user opened before shows its conversation before any server response. The owner approved saving recent comments for this on 2026-11-14. The saved reads are only the ones that first frame waits for: the recent comments window (at most 50 comments, the newest ones), their input facts, recent activity, the recent run window, interactions, attachment metadata (never file contents), live and active runs, work products and the plan document. They follow the 20-task limit and are stored in the task's own user and company record. Each task's saved chat is limited to 192 KiB and all saved chat to 1 MiB, newest tasks first. A record that storage refuses is saved again without its chat, so saved chat never displaces the rest of the cache. The other field exclusions (tokens, credentials, environment values and the like) still apply. Saved chat expires 24 hours after it was read, like every other entry. A 401 or 403 on the task or on any of its chat reads, or a 404 on the task or its comments, removes the task and its saved chat from memory and storage at once. A 404 on a plan, run or work-product read does not, because it does not mean the task is gone (a task without a plan answers 404). Restored reads are shown immediately and revalidated through the page's chat bootstrap; its answer replaces them, and they never replace newer data already in the page. Account changes also detach pending shared GETs so a new user cannot join the previous user’s private reads. Editors that need fields excluded from the display cache, including bulk agent settings, fetch complete current data before opening.

Restored identity permits cached display only. Restored inline task drafts compare their saved base with a fresh field read before each replay; conflicting edits stay in the editor for review. Account-bound writes wait for a fresh server session and are cancelled if its user changes. A definitive session denial removes saved account reads. Service-worker updates reload hidden tabs only after connectivity is online and mutations, durable sends and autosaves have settled. Durable queues synchronously report each unresolved operation, including the intervals between online rate-limit retries. Sign-out revocation also works on plain-HTTP installs without `crypto.randomUUID`.

The read cache also retains up to 100 learned link previews for the current user
and accessible companies, including unavailable results. Reloading restores the
last known PR status without a provider request. Preview timestamps keep their
original age: hover or keyboard focus reuses a fresh result and refreshes a stale
one. Stale status stays visible until then. Preview retention uses the same
24-hour expiry, build boundary, membership checks, and sign-out cleanup as other
saved reads. It does not add polling or fetch every PR on page load.

Embedded plan documents and preview work products are stripped from saved payloads. A denied task clears its UUID and identifier projections. Sign-out revocation markers contain no task content and remain after sign-out to reject stale records and delayed writes from older tabs. Session responses started before revocation cannot restore those reads, even before the storage event reaches the other tab.

Cached agents retain only safe adapter display fields and an empty runtime configuration. Their configuration objects remain present for existing display consumers; provider credentials and environment values are excluded.

A restored task shows its header and properties while uncached history is still loading. History is not persisted, and its normal placeholder remains until reads recover. The header stays visible across recovery.

Query-cache cleanup snapshots storage keys before deletion because native storage can reorder them as records are removed. Flush cleanup affects only its owning account and yields if another account becomes active.

Run `pnpm exec playwright test -c tests/e2e/playwright.config.ts tests/e2e/disconnect-resilience.spec.ts` for the built-UI outage regressions. The suite uses fresh isolated local data, 20-second API interceptions, and a controlled sign-out session response. It covers retained tasks, comment and document recovery, queued-comment reloads, cached settings/sidebar/task reads, legacy Inbox reloads, real error status handling and sign-out clearing across several company records. The existing CI e2e shards discover it automatically. A real hosted restart or deploy remains a separate acceptance check.
