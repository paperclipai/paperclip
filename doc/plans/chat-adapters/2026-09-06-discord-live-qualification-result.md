# Discord live qualification result — 2026-09-06

For the reported missing-image failure and its successful September 7 retake,
see [media qualification](2026-09-07-media-live-qualification.md).

For subsequent native Luna PNG+TXT returns and the latest deployment, use the
[September 8–9 qualification ledger](2026-09-08-chat-queue-and-webhook-repair.md).
The older gap list below is checkpoint-specific: files are no longer wholly
untested, but remaining media boundaries and server 70's normalized-button
denial still need live qualification. Gateway reconnection alone is not a
provider conversation pass.

> **Status: core Discord transport, ordered follow-up bursts, receipt cleanup, and keep-open idle recovery have live proof, but the full DC1–DC7 matrix remains unqualified.** Paperclip has verified the dedicated bot identity, Message Content intent, Clawd membership, and a permission-complete text channel against Discord. The later clean-source checkpoint supersedes the intermediate unsolicited-recovery blocker.

## Resumed live setup — 2026-09-07 UTC

The operator entered the existing bot token directly into Paperclip's masked
field; it was not reset, displayed, logged, or copied into this result. The
first connection attempt reached Discord but failed with HTTP 400 / code 50035
because Paperclip called the numeric Get Guild Member route with the literal
`@me`. The scoped repair now uses the already verified Application ID as the
bot user snowflake.

After that repair, the preserved provider token connected successfully on the
working tree based on `f5f31d2e1`. The Paperclip endpoint reached its real
`verifying` state with bot external ID `1546330979860221952` and provider
account/server ID `1457808928258658549`; the UI advanced to **Try Maya E2E in
Discord**. This provider-backed transition proves that the token identifies the
configured Application ID, Message Content intent is enabled, the bot is a
member of Clawd, and at least one text channel grants the complete required
permission set. The scoped fix and this result must be committed and its
automated checks recorded before treating the revision as a release candidate.

This was partial DC1 setup evidence at the time. The linked conversation pass
below supersedes that limitation, while DC2–DC7 and the unexercised DC1 cases
remain open.

## First native root checkpoint — 2026-09-07 UTC

In Clawd channel `1457808933082108089`, a real root mention produced the `eyes`
receipt, exactly one native public thread (`1546509943639773244`), exactly one
Paperclip task (`CHA-3`, issue `1976d84b-0bdf-4342-8afa-1a3e5d9be57c`), and one
bound conversation (`123b687c-96d7-4164-bf58-bc95edf2bc8c`). Because the
Eigenjoy Discord principal was unlinked at admission, the turn correctly
published the safe low-trust-isolation refusal in that thread instead of agent
output. The operator then completed the private identity link to the local
Paperclip board; no one-time link or credential is recorded here. A fresh root
must still prove the linked path because linking cannot retroactively change
the trust boundary of the already admitted guest turn.

The live refusal also exposed a receipt-lifecycle defect: the `eyes` reaction
remained on the root after the visible terminal failure. The implementation
had a durable add-only action and never invoked the adapter's idempotent
reaction removal, despite DC4 requiring both add and remove. The scoped repair
stages a Discord-only removal in the same transaction that records the causal
terminal publication, then attempts it under the same credential lease; a
crash or transient provider error resumes from the durable action without
replaying the terminal message. It removes the working receipt rather than
replacing it with a success or failure emoji. The fresh linked turn below
verified that the receipt is now cleared after the terminal reply.

## Successful linked round trip — 2026-09-07 UTC

The live source was the dirty working tree based on `1325329e3`, started at
13:44:55 UTC; this evidence must therefore be repeated on the final clean
release-candidate SHA before release. In Clawd `#general`, the linked Eigenjoy
principal created native thread `1546513811672932372`, exactly one Paperclip
task (`CHA-4`, issue `c65f32f8-a612-4f85-97c5-61bed2de58e2`), and one bound
conversation. Only `#general` was enabled in Paperclip; the other ten discovered
channels were disabled.

An unmentioned follow-up (`1546516684129575123`) in that native thread asked
for the exact text `DISCORD-LIVE-0907-ROUNDTRIP-OK`. Run
`2443fa37-ea1e-436b-a1af-3ad6e58afc51` ran from 13:45:11 to 13:45:17 UTC and
succeeded. Discord reply `1546516692031504485` contained the exact marker, and
the working receipt was cleared. This proves a real linked root boundary,
native thread reuse for an unmentioned follow-up, task/run execution, exact
final presentation, and terminal receipt cleanup through the configured bot.

The endpoint `af23c9d0-8d7f-495c-a45c-ba9ab1ee9686` was active and setup-complete
in the UI. After the successful reply, however, generic task recovery spawned
an unsolicited additional run (`6a3e0303-b5f2-4e32-8e36-790a892f07b6`). That is
not acceptable production behavior: a completed Discord turn must not trigger
new agent work without a new admitted user event. The recovery fix and a clean
live rerun are still required. No provider credential, identity-link secret, or
private callback value is recorded here.

### Rapid follow-up burst checkpoint

A later three-message burst on the same `CHA-4` Discord thread persisted all
three inbound messages in order. The first message started run
`4e42c03d-2c80-45ed-bb99-84a5b7c94c02`; the second and third messages were
coalesced into one deferred wake and then run
`2ae3cb6e-b33c-4c93-a029-02916210d142`. The provider-visible result was two
replies for the three inputs: an initial `ALPHA` acknowledgement, followed by
the combined exact `ALPHA BETA` result. The first turn took approximately 82.6
seconds and the second approximately 50.1 seconds, so this is ordered-delivery
and coalescing evidence, not an instant-response claim. All three working
receipts were cleared when their causal runs reached terminal publication.

The receipt-retirement audit confirms why the coalesced case is lossless:
deferred wake merging preserves the ordered `wakeCommentIds` set, promotion
copies that set to the successor run, and terminal Discord publication selects
receipt actions for every exact linked inbound comment in that run. It does not
clear unrelated or later thread receipts. No additional automatic recovery run
was present in the 13:58 UTC check, but `CHA-4` had been marked done by then;
that observation does not independently prove the new in-progress recovery
guard.

### Clean keep-open recovery qualification — 2026-09-07, 13:59 UTC

This checkpoint supersedes the pending keep-open retest and the earlier
unsolicited-recovery blocker. On clean source revision `5bd9c0d55`, an
unmentioned follow-up in native thread `1546513811672932372` left CHA-4
deliberately `in_progress` and requested exactly `DISCORD-IDLE-WAIT-OK`. Run
`f8c9dbe2-7e94-469d-8345-717eb7dad1bf` ran from `13:59:31.087Z` through
`13:59:38.234Z` and succeeded. Discord
[reply 1546520298793468036](https://discord.com/channels/1457808928258658549/1546513811672932372/1546520298793468036)
contained exactly that marker.

CHA-4 remained `in_progress` with its conversation active for more than eight
minutes after the terminal reply, with no additional run. This proves the
repaired idle-chat boundary live: an open conversation waits for new provider
input instead of being reclassified as stranded work.

After the latest setup-edge changes, the full chat integration suite passed
**258/258** and the combined process-recovery/status-payload suite passed
**135/135**, both with zero skips. The deterministic browser suite had passed
**5/5** on clean revision `5bd9c0d55`, but has not yet been rerun after the
latest setup-edge/UI changes; the current working tree is therefore not being
claimed browser-green here.

## Historical live-attempt checkpoint — superseded above

The authorized provider target is the `Clawd` Discord server, numeric ID `1457808928258658549`, using the user's Eigenjoy account. The latest in-app-browser attempt reached Discord's login/QR flow in both the Developer Portal and server tabs. It did not reach application creation or expose a bot token. Login completion is therefore the current external gate.

### Release decision at this checkpoint

At this historical checkpoint, Discord remained blocked before provider setup.
The resumed setup evidence above supersedes that gate while preserving this
record of what had not yet been tested.

Once the authenticated session is available, the required path is:

1. create a dedicated Discord application and bot for the immutable Paperclip agent;
2. enable Message Content Intent and enter only Application ID, Server ID, and the write-only bot token in Paperclip;
3. inspect the generated OAuth URL for exactly the `bot` scope and permission integer `309237763136`, with the Clawd server pinned and server selection disabled;
4. install the bot in Clawd, connect it in Paperclip, enable only the intended test channel, and execute DC1–DC7 from the browser runbook.

There is no managed bot-provisioning path, public webhook URL, interactions public key, slash command, or endpoint delivery choice in the current product.

No bot token, cookie, password, MFA value, or one-time identity-link URL is recorded here.

## Implemented behavior and remaining live proof

The current native Discord implementation includes:

- a long-lived Gateway runtime with bounded reconnect/retry behavior and full provider `retry_after` waits rather than an application-level 60-second cap;
- immutable application identity, including a database uniqueness constraint that prevents one Discord Application ID from backing multiple active Paperclip agent endpoints even across different servers;
- server and effective-channel-permission verification, channel discovery, a Paperclip allowlist, and a separate direct-message reach switch;
- one root mention to one Discord public thread and one Paperclip task, with thread replies serialized onto that task and DMs isolated into linear task generations;
- endpoint, resource, principal, and root-message preflight before provider-thread creation; denied roots retain only a payload-redacted filtered audit and create no provider thread or Paperclip work;
- crash-safe root activation: an allowed root persists a provisional receipt before the provider POST, then recovery idempotently creates or reuses the thread and treats Discord error `160004` as an existing-thread reconciliation;
- explicit missing-root filtering plus retryable ambiguous transport and authentication failures, so uncertainty is neither silently discarded nor misreported as a completed binding;
- durable message links, endpoint-generation fencing, reaction hydration, edit/delete lifecycle handling, embeds/buttons, and bounded Discord-CDN attachment ingestion;
- a fail-fast compatibility marker and required-method contract for the pinned SDK patch;
- 25-second REST deadlines and structured preservation of Discord 401, 403, 404, 429, and `retry_after` failures without copying raw provider bodies, user content, credentials, interaction tokens, or derived thread names into exceptions or logs; and
- the shared safe-publication, ambiguous-delivery, identity, permission, audit, and internal-content boundaries used by the other providers.

The linked run above now demonstrates the primary root, thread-reuse, exact
final-response, and receipt-cleanup path. The remaining items are still
code-level claims until the corresponding DC cases exercise them against the
real provider.

## Historical code-audit status before the linked live run

The final hardening removed the code-level release blockers found in the root-activation and lifecycle audit: denied roots no longer create an inert provider thread; a crash between Discord thread creation and Paperclip binding now resumes through the persisted provisional receipt and idempotent reconciliation; provider response bodies and callback errors no longer disclose content or credentials through diagnostics; retry scheduling honors long Discord backoff windows; reconnect now has a distinct, payload-redacted activity action; and Discord `50001`/`50013` destination permission failures disable only the affected resource rather than putting the whole endpoint into attention. True token/app authentication failures and unrelated authorization errors remain endpoint-wide. The compatibility marker, required patched-method checks, clean patch application against the pristine package, and 25-second REST boundary make SDK drift and stalled provider calls fail visibly rather than weakening those guarantees. Per repository policy, CI owns `pnpm-lock.yaml`; its PR workflow regenerates a lockfile artifact from the manifests before running the frozen install.

At that checkpoint, no code-audit blocker was recorded and none of the behavior
had yet been observed against the real provider account/server. The linked live
run above supersedes the latter statement and exposed the unsolicited recovery
run as a current blocker. Live proof must still cover denied-root silence,
provisional recovery, existing-thread reconciliation, files/interactions,
Gateway reconnect, rate limits, token rotation, and the visible management
surfaces. The adapter patch remains version-sensitive; any dependency update
requires the compatibility and provider contracts to rerun.

## Local regression evidence

- Final Discord implementation revision: `83018c688` (log-redaction hardening); parent merge revision: `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`.
- Before the final merge, Discord-focused adapter/runtime tests passed 41/41.
- Before the final merge, fresh PostgreSQL Discord integration tests passed 2/2, including concurrent identity claims.
- All migrations and migration-safety checks passed, including global Discord Application ID uniqueness.
- On the parent merge, the full chat-channel PostgreSQL integration suite passed 188/188 on a fresh migrated database, merge-conflict-focused server tests passed 355/355, and the deterministic five-provider browser suite passed 5/5.
- On the Discord implementation revision, the 42-test Discord adapter/runtime subset and 34-test Discord/OpenAPI/UI contract subset passed, along with server/UI typechecks, token gates, and both working-tree checks.
- The Discord patch applied cleanly to a pristine `@chat-adapter/discord@4.39.0` package, and the patched distribution passed syntax and compatibility checks. CI will regenerate the PR lockfile artifact before its frozen install, as required by repository policy.
- The post-audit Discord adapter/runtime subset passed 48/48, including raw-provider-body and callback-error redaction plus a 120-second `retry_after` contract; the focused reconnect/removal PostgreSQL scenario also passed and proved secret replacement, old-secret retirement, runtime replacement, identity/history/access preservation, redacted reconnect activity, and final Paperclip credential cleanup. Endpoint removal does not uninstall the bot from the Discord server or delete its Developer Portal application; those remain separate provider-side cleanup steps.
- The final Discord permission classifier/adapter subset passed 49/49, and its database-backed publication regression proved that `50013` cancels only the affected publication/resource while the endpoint remains active. The final combined working tree then passed 193/193 chat-channel integration tests on fresh migrated database `chat_adapters_test_final_20260906_1257`, 111/111 focused runtime/error/privacy tests, all package typechecks, token gates, and the deterministic five-provider browser suite.

This evidence supports implementation integrity. Provider installation,
Message Content intent, effective `#general` permission, a native root/thread,
linked identity, exact final reply, and receipt cleanup now also have live
proof. It does not replace the remaining Gateway-reconnect, rate-limit,
restart, file, action, negative-reach, token-rotation, and cleanup cases.

## Qualification gap at the September 7 checkpoint

Provider credential validation, Message Content intent, Clawd membership,
`#general` enablement, root-thread creation, a linked unmentioned follow-up,
exact final presentation, and working-receipt removal now have live proof. The
unsolicited post-completion recovery run was repaired, and the clean keep-open
checkpoint above proves the fix against the real provider.
The live three-message burst now proves ordered persistence, deferred coalescing,
two causal runs, combined final presentation, and cleanup of every causal
receipt, with the observed 82.6-second and 50.1-second turn latency recorded
above. Disabled-channel silence, denied-user behavior, provisional recovery,
existing-thread reconciliation, duplicate/reconnect fencing, edits/deletes,
embeds/actions, inbound/outbound files, DMs, ambiguous sends, token rotation,
intent revocation, provider links, management surfaces, and cleanup remain
open. Discord remains unqualified for stable release until the remaining DC
cases pass on one final clean release-candidate SHA.
