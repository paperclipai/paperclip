# Discord live qualification result — 2026-09-06

> **Status: implementation and local regression evidence only; blocked before provider setup.** No Discord application, Paperclip endpoint, server installation, Gateway event, thread, task, publication, or recovery scenario has been qualified live on the current working tree.

## Live-attempt checkpoint

The authorized provider target is the `Clawd` Discord server, numeric ID `1457808928258658549`, using the user's Eigenjoy account. The latest in-app-browser attempt reached Discord's login/QR flow in both the Developer Portal and server tabs. It did not reach application creation or expose a bot token. Login completion is therefore the current external gate.

Once the authenticated session is available, the required path is:

1. create a dedicated Discord application and bot for the immutable Paperclip agent;
2. enable Message Content Intent and enter only Application ID, Server ID, and the write-only bot token in Paperclip;
3. inspect the generated OAuth URL for exactly the `bot` scope and permission integer `309237763136`, with the Clawd server pinned and server selection disabled;
4. install the bot in Clawd, connect it in Paperclip, enable only the intended test channel, and execute DC1–DC7 from the browser runbook.

There is no managed bot-provisioning path, public webhook URL, interactions public key, slash command, or endpoint delivery choice in the current product.

No bot token, cookie, password, MFA value, or one-time identity-link URL is recorded here.

## Implemented behavior awaiting live proof

The current native Discord implementation includes:

- a long-lived Gateway runtime with bounded reconnect/retry behavior and provider `retry_after` handling;
- immutable application identity, including a database uniqueness constraint that prevents one Discord Application ID from backing multiple active Paperclip agent endpoints even across different servers;
- server and effective-channel-permission verification, channel discovery, a Paperclip allowlist, and a separate direct-message reach switch;
- one root mention to one Discord public thread and one Paperclip task, with thread replies serialized onto that task and DMs isolated into linear task generations;
- endpoint, resource, principal, and root-message preflight before provider-thread creation; denied roots retain only a payload-redacted filtered audit and create no provider thread or Paperclip work;
- crash-safe root activation: an allowed root persists a provisional receipt before the provider POST, then recovery idempotently creates or reuses the thread and treats Discord error `160004` as an existing-thread reconciliation;
- explicit missing-root filtering plus retryable ambiguous transport and authentication failures, so uncertainty is neither silently discarded nor misreported as a completed binding;
- durable message links, endpoint-generation fencing, reaction hydration, edit/delete lifecycle handling, embeds/buttons, and bounded Discord-CDN attachment ingestion;
- a fail-fast compatibility marker and required-method contract for the pinned SDK patch;
- 25-second REST deadlines and structured preservation of Discord 401, 403, 404, 429, and `retry_after` failures; and
- the shared safe-publication, ambiguous-delivery, identity, permission, audit, and internal-content boundaries used by the other providers.

These are code-level claims until the real provider run demonstrates them.

## Current production-quality status

The final hardening removed the two code-level release blockers found in the root-activation audit: denied roots no longer create an inert provider thread, and a crash between Discord thread creation and Paperclip binding now resumes through the persisted provisional receipt and idempotent reconciliation. The compatibility marker, required patched-method checks, clean patch application against the pristine package, and 25-second REST boundary make SDK drift and stalled provider calls fail visibly rather than weakening those guarantees. Per repository policy, CI owns `pnpm-lock.yaml`; its PR workflow regenerates a lockfile artifact from the manifests before running the frozen install.

No current code-audit blocker is recorded here. Discord is nevertheless not production-ready because none of the behavior has been observed against the real provider account/server. In particular, live proof must cover denied-root silence, provisional recovery, existing-thread reconciliation, files/interactions, Gateway reconnect, rate limits, token rotation, and the visible management surfaces. The adapter patch remains version-sensitive; any dependency update requires the compatibility and provider contracts to rerun.

## Local regression evidence

- Final Discord implementation revision: `83018c688` (log-redaction hardening); parent merge revision: `da8f83d6c9befe7bf958f6d9cf12a95fc7e59e88`.
- Before the final merge, Discord-focused adapter/runtime tests passed 41/41.
- Before the final merge, fresh PostgreSQL Discord integration tests passed 2/2, including concurrent identity claims.
- All migrations and migration-safety checks passed, including global Discord Application ID uniqueness.
- On the parent merge, the full chat-channel PostgreSQL integration suite passed 188/188 on a fresh migrated database, merge-conflict-focused server tests passed 355/355, and the deterministic five-provider browser suite passed 5/5.
- On the Discord implementation revision, the 42-test Discord adapter/runtime subset and 34-test Discord/OpenAPI/UI contract subset passed, along with server/UI typechecks, token gates, and both working-tree checks.
- The Discord patch applied cleanly to a pristine `@chat-adapter/discord@4.39.0` package, and the patched distribution passed syntax and compatibility checks. CI will regenerate the PR lockfile artifact before its frozen install, as required by repository policy.

This evidence supports implementation integrity but does not replace provider login, installation, Message Content intent, effective channel permission, Gateway, rate-limit, reconnect, native thread, file, action, identity-governance, negative-reach, token-rotation, and cleanup proof.

## Qualification gap

Every live Discord scenario remains open: first-time setup, least-privilege install, enabled/disabled channel behavior, denied-user behavior, root-thread creation, provisional recovery, existing-thread reconciliation, ordered follow-ups, duplicate/reconnect fencing, reactions, edits/deletes, embeds/actions, inbound/outbound files, DMs, linked/unlinked identities, ambiguous sends, token rotation, intent revocation, provider links, management surfaces, and cleanup. Discord remains unqualified for stable release until those cases pass on one final release-candidate SHA. The current external blocker is the Eigenjoy Discord login/QR gate, not a known unresolved root-activation implementation defect.
