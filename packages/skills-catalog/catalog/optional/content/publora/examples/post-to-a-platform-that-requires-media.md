# Example: a platform that requires media, and one that is not connected

Shows the upload sequence for TikTok and the correct way to fail when an
account the issue asks for does not exist.

## Input

Issue `ISSUE-4137`, assigned to the devrel agent:

> Push the demo clip to TikTok and YouTube. File is at
> `./assets/demo-scheduling.mp4`, caption below.

Caption:

> Four accounts, one schedule. 40 seconds.

## Application

**Step 1 — read the connections.**

```
list_connections
```

```json
[
  { "platformId": "tiktok-2c8845", "platform": "tiktok", "name": "@exampleinc" },
  { "platformId": "linkedin-org-9d21c4", "platform": "linkedin", "name": "Example Inc." }
]
```

TikTok is connected. **YouTube is not.** The agent does not substitute another
account and does not try to connect one — that is a human action in the Publora
dashboard. It says so in the issue and continues with TikTok only:

> YouTube is not connected to this company's Publora account, so it is out of
> scope for this run. Connect it in the dashboard and reopen if you want the
> clip there too. Proceeding with TikTok.

**Step 2 — platform requirements.** TikTok cannot take a text-only post, and
the file is local rather than a public URL, so it goes through the upload
sequence.

Create the draft first, without a scheduled time:

```
create_post
  platforms: ["tiktok-2c8845"]
  content: "Four accounts, one schedule. 40 seconds."
```

→ `pst_77c103`, status `draft`.

Then upload the file. The name is unique, so it will not collapse into an
existing media item:

```
get_upload_url  fileName: "demo-4137-scheduling.mp4"
```

→ a signed URL. The bytes go up with a plain HTTP `PUT`, then:

```
complete_media  ...
```

**Step 3 — dry run.** Skipped: the connection was already proved on this
company in `ISSUE-4120`, and the media path was exercised by the upload calls
themselves, which succeeded.

**Step 4 — confirmation.** Raised on the issue, bound to the caption revision,
with `continuationPolicy: wake_assignee_on_accept` so the acceptance wakes the
agent:

> Publish to **@exampleinc** (TikTok) on **2026-08-06T15:00:00Z** — 17:00
> Berlin, the next slot in the content calendar.
> Caption: "Four accounts, one schedule. 40 seconds."
> Media: `demo-4137-scheduling.mp4` (attached, 40s).
> YouTube skipped — not connected.

Accepted. The agent wakes on the acceptance and continues from there.

**Step 5 — send.** The draft flips to the confirmed time, not to any other:

```
update_post  pst_77c103  status: "scheduled"  scheduledTime: "2026-08-06T15:00:00Z"
```

TikTok privacy and other per-network options would go in `platformSettings`
here, not in the caption.

## Output

A comment on `ISSUE-4137`:

> Scheduled: post `pst_77c103` → @exampleinc (TikTok), 2026-08-06T15:00:00Z,
> with `demo-4137-scheduling.mp4`.
> **Not done:** YouTube — no connected account. Needs a human to connect it in
> Publora, then reopen this issue.

The unfinished half is stated as plainly as the finished half. Silently
dropping the YouTube half would read as "shipped" in the next status roll-up.
