# Example: schedule a release announcement to LinkedIn and X

Text-only post, two platforms, scheduled rather than immediate. This is the
common case.

## Input

Issue `ISSUE-4120`, assigned to the marketer agent:

> v2.4 ships Thursday. The changelog is written. Get the announcement out on
> our LinkedIn page and our X account on Thursday morning, our time (Berlin).

Approved copy, already in the issue as document revision `rev_8f21`:

> Scheduling is now per-account instead of per-post. Pick the account, pick the
> time, done — no more duplicating a post four times to hit four calendars.
>
> Full changelog: https://example.com/changelog/v2-4

## Application

**Step 1 — read the connections.**

```
list_connections
```

```json
[
  { "platformId": "linkedin-org-9d21c4", "platform": "linkedin", "name": "Example Inc." },
  { "platformId": "x-4471aa", "platform": "x", "name": "@exampleinc" },
  { "platformId": "instagram-77b0e2", "platform": "instagram", "name": "example.inc" }
]
```

Both requested accounts exist. The ids are copied character for character;
Instagram is ignored because the issue did not ask for it.

**Step 2 — platform requirements.** Neither LinkedIn nor X requires media, and
the copy has none. Nothing to upload.

**Step 3 — dry run.** First publishing run for this company, so the payload is
proved against the throwaway target before a real account is touched:

```
create_post
  platforms: ["publora-playground"]
  content: "<the approved copy>"
```

Acknowledged and discarded. Nothing was published.

**Step 4 — confirmation.** Thursday 09:00 in Berlin is `07:00Z` in August.
A confirmation card is raised on the issue, bound to `rev_8f21`, with
idempotency key `confirmation:issue-4120:publish:rev_8f21`:

> Publish this text to **Example Inc.** (LinkedIn) and **@exampleinc** (X) on
> **2026-08-13T07:00:00Z** — 09:00 Berlin. No media attached.
>
> <the approved copy>

The board member accepts. Nothing was sent before that.

**Step 5 — schedule.**

```
create_post
  platforms: ["linkedin-org-9d21c4", "x-4471aa"]
  content: "<the approved copy>"
  scheduledTime: "2026-08-13T07:00:00Z"
```

## Output

A comment on `ISSUE-4120`:

> Scheduled for 2026-08-13T07:00:00Z (09:00 Berlin) — post `pst_51ba9c`.
> Targets: Example Inc. (LinkedIn), @exampleinc (X). No media.
> Confirmed by @board-member on revision rev_8f21.
> Verify or cancel before Thursday with `get_post pst_51ba9c`.

The post id in the thread is what makes this auditable: anyone can check the
queue later without guessing what went out.
