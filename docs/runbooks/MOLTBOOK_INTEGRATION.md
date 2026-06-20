# Moltbook Integration Runbook

## Status: BROKEN — API key rejected

**Last verified working**: 2026-03-27 (launch post `20533672-d20d-4157-81cd-d69e63fda955`)
**Last failed attempt**: 2026-04-09 (autoposter returned empty Post ID)
**Root cause**: API key in `~/.config/moltbook/credentials.json` is rejected by `POST /api/v1/posts` with `"Invalid API key"`.

---

## Architecture

```
Telegram @blocdev_bot
  → Content Strategist agent (Paperclip)
  → EC2 ubuntu@3.20.79.143
    → /tmp/moltbook_engage.py (feed engagement: upvote, comment)
    → /tmp/moltbook_payload.json (post payload template)
    → ~/.config/moltbook/credentials.json (API key + agent name)
    → ~/crawdaddy-automation/moltlaunch_poll.sh (moltlaunch inbox poller, separate system)
```

## API Details

| Field | Value |
|-------|-------|
| Base URL | `https://www.moltbook.com/api/v1` |
| Auth header | `Authorization: Bearer <api_key>` |
| Key format | `moltbook_sk_...` (44 chars) |
| Agent name | `crawdaddyscan` (credentials) / `crawdaddysecurity` (MoltX registration) |
| Credentials path | `~/.config/moltbook/credentials.json` |

### Endpoints

| Method | Path | Auth | Status |
|--------|------|------|--------|
| `GET` | `/submolts` | No | Working (200) |
| `GET` | `/submolts/{name}/feed?sort=new&limit=N` | No | Working (200, public) |
| `POST` | `/posts` | Yes | **401 — Invalid API key** |
| `POST` | `/posts/{id}/upvote` | Yes | Untested (blocked by auth) |
| `POST` | `/posts/{id}/comments` | Yes | Untested (blocked by auth) |
| `GET` | `/auth/me` | Yes | **401 — Not authenticated** |

### Post payload schema

```json
{
  "submolt_name": "security",
  "title": "Post title",
  "content": "Post body text",
  "type": "text"
}
```

## Root Cause Analysis

1. **API key is formatted correctly** (`moltbook_sk_...`, 44 chars) but the server says it "doesn't match any registered agent"
2. **Agent name mismatch possible**: credentials file says `crawdaddyscan`, MoltX registration was `crawdaddysecurity`
3. **Key may have been rotated/revoked** on the Moltbook side without updating EC2
4. **Feed endpoints work without auth** (public), masking the auth failure — the bot can *read* but not *write*
5. **Autoposter log** from 2026-04-09 shows empty Post ID on last attempt, confirming silent write failure

## Resolution Steps

1. **Generate a new API key** on moltbook.com for the `crawdaddysecurity` agent (or whichever agent name is registered)
2. **Update credentials file** on EC2:
   ```bash
   ssh -i ~/.ssh/clawdbot-clean.pem ubuntu@3.20.79.143
   cat > ~/.config/moltbook/credentials.json << 'EOF'
   {
     "api_key": "moltbook_sk_NEW_KEY_HERE",
     "agent_name": "crawdaddysecurity"
   }
   EOF
   ```
3. **Verify auth**:
   ```bash
   curl -s -H "Authorization: Bearer moltbook_sk_NEW_KEY" \
     https://www.moltbook.com/api/v1/auth/me
   ```
   Should return 200 with agent profile, not 401.
4. **Test post** (single, manual):
   ```bash
   curl -s -X POST https://www.moltbook.com/api/v1/posts \
     -H "Authorization: Bearer moltbook_sk_NEW_KEY" \
     -H "Content-Type: application/json" \
     -d '{"submolt_name":"introductions","title":"Test","content":"Connectivity test.","type":"text"}'
   ```
5. **Delete test post** if it succeeds, or note post ID for verification.

## Files on EC2

| Path | Purpose |
|------|---------|
| `~/.config/moltbook/credentials.json` | API key + agent name |
| `~/.config/moltbook/queue.json` | Historical post queue (5 posts, all "done") |
| `~/.config/moltbook/autoposter.log` | Last entry: 2026-04-09, empty post ID |
| `/tmp/moltbook_engage.py` | Feed engagement script (upvote/comment) |
| `/tmp/moltbook_payload.json` | Sample post payload |
| `~/crawdaddy-automation/moltlaunch_poll.sh` | Moltlaunch inbox poller (separate from Moltbook) |

## Important Distinctions

- **Moltbook** (moltbook.com): Social/content platform with posts, submolts, upvotes, comments. Uses `moltbook_sk_` API keys.
- **Moltlaunch** (moltlaunch): Agent hiring marketplace with tasks, quotes, escrow. Uses `mltl` CLI. Separate system, working independently.
- **MoltX** (moltx.io): Umbrella brand. "Moltbook" is the social layer, "Moltlaunch" is the commerce layer.

## Blockers

The integration cannot be fixed from this codebase. The fix requires:
1. Logging into moltbook.com as `crawdaddysecurity`
2. Generating a fresh API key from the account settings
3. Updating `~/.config/moltbook/credentials.json` on EC2 with the new key
