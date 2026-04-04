---
name: wait-for-board
description: >
  Poll-and-wait pattern for situations where the agent needs user action
  before continuing (e.g., browser login, MFA code, Telegram reply).
  Keeps the agent process alive so browser state is preserved.
---

# Wait For Board Skill

Use this skill when you need the user (board) to take an action before you can continue — for example, logging into a website, entering an MFA code, replying to a Telegram message, or confirming something on screen.

**This skill keeps your process alive** so the browser and all other state is preserved while you wait.

## When to use

- You're in the browser and need the user to log in or enter credentials
- You sent a Telegram message and are waiting for a response
- You need the user to complete an action on a platform you can't automate (MFA, CAPTCHA, OAuth consent)
- You're waiting for an external event that the user can confirm

## Procedure

### 1. Post a comment explaining what you need

Before entering the wait loop, post a clear comment on your current issue:

```sh
curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments" \
  -X POST \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
  -d '{"body": "**Waiting for board action:** [describe exactly what you need]. I will check every 20 seconds for up to [N] minutes."}'
```

Be specific about what you need. Examples:
- "Please log in to Allegro in the browser window. I will detect when the dashboard loads."
- "Please enter the MFA code sent to your phone. I will check the page every 20 seconds."
- "Waiting for a reply to the Telegram message I drafted. I will check for new messages."

### 2. Determine the timeout

Choose the right timeout based on the situation:

| Situation | Timeout |
|-----------|---------|
| Browser login (no MFA) | 10 minutes |
| MFA / OTP code entry | 5 minutes |
| Time-sensitive verification code | Match the code's expiry |
| Telegram / email reply | 10 minutes |
| OAuth consent screen | 10 minutes |
| Default | 10 minutes |

### 3. Enter the poll loop

Poll every **20 seconds** until either:
- **Success condition** is met (you detect the state change), OR
- **User replies** with a comment on the issue (e.g., "done", "ready", "logged in"), OR
- **Timeout** is reached

#### How to detect success

**Browser-based waits:** Take a `browser_snapshot` each cycle and check if the page state has changed (e.g., logged-in dashboard appeared, MFA screen is gone, new content loaded). This is preferred over waiting for a comment — detect the change automatically when possible.

**Message-based waits (Telegram, email):** Check the conversation for new messages since you posted.

**Comment-based confirmation:** If you can't detect the state change automatically, check for new comments:

```sh
curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Look for comments posted after your waiting comment. Any reply from the board means you can proceed.

### 4. Poll loop pseudocode

```
max_wait = chosen timeout in seconds
interval = 20 seconds
elapsed = 0
my_comment_time = timestamp of the comment you posted in step 1

WHILE elapsed < max_wait:
    # Check for success (prefer automatic detection)
    IF browser wait:
        snapshot = browser_snapshot()
        IF success_condition_met(snapshot):
            post comment: "Detected [what changed]. Continuing."
            CONTINUE WORKING

    IF message wait:
        check for new messages in conversation
        IF new relevant message found:
            post comment: "Response received. Continuing."
            CONTINUE WORKING

    # Check for user comment reply (fallback)
    comments = GET /api/issues/{id}/comments
    IF any comment from board/user posted after my_comment_time:
        post comment: "Board confirmed. Continuing."
        CONTINUE WORKING

    WAIT 20 seconds
    elapsed += 20

# Timeout reached
post comment: "Timed out after {max_wait/60} minutes waiting for board action. Setting task to blocked."
PATCH issue status to "blocked"
EXIT
```

### 5. On timeout

If the timeout is reached without success:

1. **Post a comment** explaining the timeout:
   ```
   Timed out after 10 minutes waiting for [action]. Setting task to blocked.
   To resume: complete the action and then wake me via a comment.
   ```

2. **Set the issue status to `blocked`**:
   ```sh
   curl -sS "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID" \
     -X PATCH \
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \
     -d '{"status": "blocked"}'
   ```

3. **Exit cleanly.** When the user later completes the action and comments on the issue, you will be woken up automatically and can resume.

## Rules

- **Never wait silently.** Always post a comment before entering the loop so the board knows what's needed.
- **Prefer automatic detection** over waiting for a comment. If you can check the browser or platform state directly, do that.
- **Never exceed the timeout.** If the user doesn't respond, block the task and exit gracefully.
- **Don't spam comments.** Post one waiting comment, then poll silently. Only post again on success or timeout.
- **Keep snapshots light.** Use `browser_snapshot` (not screenshots) during polling to minimize overhead.
