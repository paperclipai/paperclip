---
name: ask-human
description: >
  Ask a human for input, approval, review, or a handoff artifact on behalf of
  a Paperclip issue. Posts a tagged message into the correct company Discord
  channel via OpenClaw's bot; the human's reply lands automatically as a
  comment on the same Paperclip issue. Use for review requests, content
  approvals, video script hand-offs, or any ask where an agent needs a human
  response to continue. Transport-agnostic: today it's Discord; same shape
  will work when iMessage/Telegram are wired through OpenClaw. Channel map
  lives in .gsai/openclaw-routing.json; reply-routing protocol lives in
  .gsai/openclaw-protocol.md.
---

# ask-human — Human-in-the-Loop Round-Trip

## What This Is

A one-call bridge between a Paperclip issue and Vasanth on Discord.

- **You post**: `ask.sh <channel-name> <issue-id> <kind> <body>`
- **Vasanth sees**: a tagged message in the right company channel
- **Vasanth replies**: in the thread (or as a Discord reply to the message)
- **You see**: a new comment on your Paperclip issue with the reply text, with
  `interrupt: true` so your agent wakes immediately

No polling. No manual hand-off. No separate ticket tree.

## How It Works (End-to-End)

1. `ask.sh` reads `/Users/vasanth/.gsai/openclaw-routing.json` to resolve the channel name to a Discord channel ID + Paperclip org prefix.
2. It asserts `<issue-id>` matches the channel's org prefix (e.g. `CFW-87` for `#cfw`). This prevents cross-posting mistakes.
3. It calls `openclaw message send --channel discord --target <channel_id> -m "<formatted body>"`. The message always leads with `[<issue-id>]` on the first line so the OpenClaw worker agent can route the reply back.
4. OpenClaw's Discord extension binds the thread to the worker agent's `agentId`, so when Vasanth replies, the reply is delivered to the worker.
5. The worker, following `.gsai/openclaw-protocol.md`, extracts `<issue-id>` from the thread's first-line tag and POSTs to `{paperclipApi}/api/issues/{issue-id}/comments` with `interrupt: true`.
6. Your originating Paperclip agent wakes, sees the new comment, continues.

## Auth

Scripts read `PAPERCLIP_API_KEY` from env or `.gsai/secret`. The worker agent (not this skill) is what actually calls Paperclip, so `PAPERCLIP_API_KEY` only matters if you're running `test.sh` in live-post mode.

The skill itself calls `openclaw message send`, which uses the Discord account already configured in OpenClaw. No Discord token needed here.

## Usage

```bash
# Post a video-script request to the #cfw channel for Paperclip issue CFW-87
./ask.sh "#cfw" "CFW-87" "video_script_request" "$(cat script.md)"

# Post a generic review request
./ask.sh "#gsai" "GRO-142" "review_request" "Please check the new landing-page copy below and reply with notes."

# Dry-run to see the exact openclaw CLI invocation without sending
./ask.sh --dry-run "#cfw" "CFW-87" "video_script_request" "draft text"
```

## Parameters

| Arg | Required | Description |
|---|---|---|
| `<channel-name>` | yes | Must match a `name` in `openclaw-routing.json` (e.g. `#cfw`, `#gsai`). |
| `<issue-id>` | yes | Paperclip issue id with the org prefix, e.g. `CFW-87`. The prefix must match the channel's bound org. |
| `<kind>` | yes | One of: `video_script_request`, `review_request`, `approval_request`, `question`, `handoff`. Used for the title line; drives the emoji + phrasing. |
| `<body>` | yes | The content. Multi-line OK. Pass via `$(cat file.md)` for scripts. |

## Body structure requirements by `<kind>`

### `video_script_request` — **MUST** include a TTS-ready section

Vasanth records the voiceover directly from the Discord post — usually on mobile, usually by copy-pasting into ElevenLabs, HeyGen, or similar. Mixing production directions with spoken text forces him to hand-strip brackets, scene headers, timing notes, and visual cues. Don't do that to him.

**Always structure a video script body as two sections separated by a delimiter:**

```
[Scene 1 — Hook] (8s) [visual: close-up, direct to camera]
"What if I told you…"

[Scene 2 — Problem] (12s) [visual: b-roll montage, overwhelmed founder]
"Most solo founders spend…"

… (rest of production script with visual notes, scene headers, timing) …


=== TTS-READY SCRIPT ===

What if I told you…

Most solo founders spend…

… (rest of spoken text ONLY — no brackets, no scene headers, no timing notes, no visual cues, no stage directions) …
```

The **full production script** goes on top — preserves all context for review decisions. **This is what shows up inline in the Discord message.**

The **TTS-READY SCRIPT** section goes below a clear delimiter (`=== TTS-READY SCRIPT ===`). It must be pure spoken text, in delivery order, with paragraph breaks between beats. **Nothing a TTS engine would vocalize incorrectly** — no `[brackets]`, no `(parens with timing)`, no `**bold**`, no scene markers. **This is what ends up as the attachment file — alone, with no header or footer, so the human can copy-paste it straight into a TTS tool with zero cleanup.**

The delimiter line itself is NOT included in the attachment. The skill strips it when splitting.

If you invoke `ask.sh` with `kind=video_script_request` and your body does NOT contain the `=== TTS-READY SCRIPT ===` delimiter, the skill exits with `rc=9` and a helpful message. The delimiter is mandatory for video scripts because the whole value-prop (paste-ready TTS file) depends on it.

### Other kinds

- `review_request`, `approval_request`, `question`, `handoff` — no mandatory structure. Body is freeform. Just make the ask clear and specific.

## Script Reference

| Script | Purpose |
|---|---|
| `ask.sh` | Send the notification. Supports `--dry-run`. |
| `test.sh` | Validate the skill layout + do a dry-run post for every supported `<kind>`. No network calls. |

## What goes in the attachment vs the Discord message

**Mode 1 — `video_script_request` (TTS-split, always attaches):**

- **Attachment** (`~/.openclaw/media/<ISSUE>-tts-script.txt`): ONLY the spoken text below the `=== TTS-READY SCRIPT ===` delimiter. No header, no footer, no delimiter line, no brackets, no scene markers, no timing notes. **Paste-ready for ElevenLabs/HeyGen — zero chars to delete.**
- **Discord message body**: the production context (scene headers, visual notes, timing, beat breakdowns) — everything above the delimiter. May chunk across multiple Discord posts if long; routing tag `[<PREFIX>-<N>]` stays in the first chunk so reply-to-first still routes correctly.

**Mode 2 — other kinds (freeform body):**

- Short body (≤ 1500 chars) stays inline in a 4-backtick fenced code block for one-tap mobile copy.
- Long body (> 1500 chars) goes entirely into a `.txt` attachment; Discord message becomes just the header + 📎 pointer.

> **Why `~/.openclaw/media/` and not `$TMPDIR`?** OpenClaw's `--media` flag has an allowlist; `$TMPDIR` is NOT on it and produces `LocalMediaAccessError: path-not-allowed`. Override via `$ASK_HUMAN_MEDIA_DIR` or `$OPENCLAW_HOME` if you've customized OpenClaw's home.

In all modes, the routing-key tag `[<PREFIX>-<N>]` is in the first line of the Discord message. The OpenClaw worker agent's reply-routing logic is unchanged.

## Status handshake (issue gets parked in `in_review`)

When `ask.sh` succeeds, it **PATCHes the issue status to `in_review`**. Paperclip's stranded-issue reconciler only sweeps `todo` and `in_progress` issues, so `in_review` issues are never auto-blocked while parked waiting for a human.

When the human replies in Discord, the OpenClaw worker agent:
1. POSTs the reply text as a comment on the issue
2. PATCHes the issue back to `in_progress`
3. The reconciler (or Paperclip's comment-interrupt path) wakes the originating agent to process the comment.

See `~/.gsai/openclaw-protocol.md` for the full worker-side protocol.

## Common Issues

- **"channel not in routing.json"** — confirm the channel exists in `/Users/vasanth/.gsai/openclaw-routing.json`. Names are matched with or without leading `#`.
- **"issue prefix doesn't match channel org"** — cross-checking prevents e.g. posting `GRO-1` to `#cfw`. Use the right channel for the issue's org.
- **"openclaw CLI not on PATH"** — run `which openclaw`. The skill shells out to `openclaw message send`; that binary must be resolvable.
- **Reply didn't land on the Paperclip issue** — check the worker agent is running and has been given `.gsai/openclaw-protocol.md` as context. Verify `PAPERCLIP_API_KEY` is set in the worker's env.
