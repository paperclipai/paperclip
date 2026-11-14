# Pi steering after a restart: known limit and follow-up

Status: accepted limit, 2026-11-07. Follow-up planned for the next Pi re-qualification.
Context: [#19962](https://github.com/paperclipai/paperclip/pull/19962) (restart recovery delivers unread steered messages) and [#19970](https://github.com/paperclipai/paperclip/pull/19970) (automatic steering).

## Summary

- **Codex: exactly once.** Restart recovery reads the run log. Each `userMessage` item after the turn's own input reads the oldest unread steer in that turn. If the read arrives before its acknowledgement, it waits for the next acknowledgement in that turn. The restart continuation delivers only the acknowledged messages that have not been read.
- **Pi: never lost, sometimes duplicated.** Pi gives the run log no read evidence for a steer. If Pi read a steer and a restart then interrupts the same turn, the restart continuation delivers that message again. The agent sees it twice. It is never lost.
- **This is rare and visible:** it needs a steer, a read, and a restart in the same turn, and the duplicate shows in the transcript.

## Why Pi has no read evidence

- Pi's native runtime emits a `message_start` with role `user` when it delivers a queued steer into the conversation.
- The pinned pi-acp wrapper (`patches/pi-acp@0.0.33.patch`) does not forward that event, and acpx has no parser for ACP `user_message_chunk` updates.
- Runner-side inference is unsafe. For example, "an assistant message started after the acknowledgement": Pi checks its steering queue before the model call, but the assistant `message_start` arrives only when the response starts streaming. A steer queued in that gap would count as read and be lost.
- A restored session's history does not help either. A resumed ACPX session loads on its first prompt, so Pi replays its saved history after the continuation prompt is already sent.

## Follow-up for the next Pi re-qualification (option A)

1. In pi-acp, forward Pi's native user `message_start` as an ACP update with Pi-native provenance, for the turn's own input and for each delivered steer.
2. Map it through acpx, the ACPX sidecar and the Rust ACPX backend to a `userMessage` item in the run log.
3. The existing rule in `packages/paperclip-runner/src/steering-delivery.ts` then covers Pi unchanged. The first `userMessage` of a turn is its own input; each later one reads a steer.
4. Add a red/green test with a Pi fixture: a steer read before the crash is not delivered again, and an unread one is delivered once.

Cost, which is why this waits for a re-qualification:

- The wrapper patch and `pi-acp-runtime.ts` are part of the Pi distribution closure. All three closure pins (`pi-closure-pins.ts`) must be regenerated on their target hosts.
- The Pi `commandDigest` changes, so saved Pi sessions start fresh.
- Pi paid qualification must run again.
- The new runtime event is a Runner/pack contract and changes the pack `contractDigest` (`rules/acpx-profile-identity.mdc`).

## Options considered and rejected

- **Dedupe against Pi's replayed history at restore (eager load).** It works only with an eager session load before the continuation, plus changes in five places: an acpx patch, a sidecar command, a Rust pass-through, a harness method, and the recovery filter. Not worth it for a rare duplicate.
- **Steer the unread messages into the continuation after the history replay.** This is racier, and it depends on when Pi takes a steer.
