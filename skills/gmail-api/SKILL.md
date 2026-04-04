---
name: gmail-api
description: Read-only Gmail API access for searching, reading, and validating email via OAuth2 credentials
---

# Gmail API Skill

Use this skill for any Gmail operation that does NOT require browser automation. This replaces Playwright MCP-based Gmail access for read operations (search, read messages, check for replies, list labels).

## When to Use

- Searching for emails (invoices, replies, notifications)
- Reading message content and headers
- Checking if a reply was received from a specific sender
- Listing labels or recent messages
- Any read-only Gmail operation

## When NOT to Use

- Sending emails (use the Comms Manager's pipeline or draft in browser)
- Modifying labels (Comms Manager's domain)
- OAuth2 initial setup (board action required)

## Prerequisites

**Python packages** (usually pre-installed):
```
google-auth google-auth-oauthlib google-api-python-client
```

If missing: `pip install google-auth google-auth-oauthlib google-api-python-client`

**Credentials** must exist at one of:
1. `$GMAIL_CREDENTIALS_DIR/` (env var override)
2. `~/.paperclip/gmail/` (default shared location)

Each location must contain:
- `credentials.json` — OAuth2 Desktop Client ID (from GCP project `dspot-agentic-work`)
- `token.json` — Stored refresh token (auto-refreshes)

If credentials are missing, escalate to the board — credential setup requires human OAuth consent.

## Usage

The `gmail_read.py` script is in this skill's `scripts/` directory. Find it relative to this SKILL.md file.

### Validate credentials

```bash
python <skill-path>/scripts/gmail_read.py validate
```

Returns: email address, message count, credentials directory. Run this first to confirm access works.

### Search messages

```bash
# Search by sender
python <skill-path>/scripts/gmail_read.py search "from:vendor@example.com"

# Search with date range
python <skill-path>/scripts/gmail_read.py search "subject:invoice after:2026/01/01 before:2026/02/01" --max 20

# Search for replies from a specific person
python <skill-path>/scripts/gmail_read.py search "from:biuro@example.com after:2026/03/24"

# Search with amount (invoice matching)
python <skill-path>/scripts/gmail_read.py search "979.80 OR 979,80 after:2026/01/01 before:2026/04/01"

# Search with attachments
python <skill-path>/scripts/gmail_read.py search "has:attachment from:vendor@example.com"
```

### Get full message

```bash
python <skill-path>/scripts/gmail_read.py get <message_id>
```

Returns: headers, body text, attachments list, labels.

### Get headers only (lightweight)

```bash
python <skill-path>/scripts/gmail_read.py headers <message_id>
```

### List recent messages

```bash
python <skill-path>/scripts/gmail_read.py list-recent --max 5
```

### List labels

```bash
python <skill-path>/scripts/gmail_read.py labels
```

### Download attachment

First, get the message to find attachment IDs:

```bash
python <skill-path>/scripts/gmail_read.py get <message_id>
# Look for "attachmentId" in the "attachments" array
```

Then download:

```bash
python <skill-path>/scripts/gmail_read.py download-attachment <message_id> <attachment_id> /path/to/save/invoice.pdf
```

Creates parent directories automatically. Returns JSON with output path and file size.

## Output Format

All commands output JSON to stdout. Parse with your language's JSON tools. Errors go to stderr.

## Checking for Replies (Common Pattern)

To check if someone replied to an email you sent:

```bash
# Search for messages from the recipient after the send date
python <skill-path>/scripts/gmail_read.py search "from:recipient@example.com after:2026/03/24" --max 5
```

If results are returned, read the most recent one to confirm it's a reply to your message:

```bash
python <skill-path>/scripts/gmail_read.py get <message_id>
```

Check the `threadId` — if it matches the original sent message's thread, it's a direct reply.

## Invoice Search (Common Pattern)

For searching invoices, run multiple queries to maximize coverage:

```bash
# 1. Amount search (mandatory)
python <skill-path>/scripts/gmail_read.py search "979.80 OR 979,80 after:2026/01/01 before:2026/04/01"

# 2. Vendor name
python <skill-path>/scripts/gmail_read.py search "Vendor Name after:2026/01/01 before:2026/04/01"

# 3. Vendor with attachments
python <skill-path>/scripts/gmail_read.py search "has:attachment Vendor Name after:2026/01/01"

# 4. Invoice keywords
python <skill-path>/scripts/gmail_read.py search "faktura OR invoice OR rachunek Vendor after:2026/01/01"
```

## Token Refresh

The script auto-refreshes expired tokens and saves the updated token back to disk. If refresh fails, the token may need re-authorization — escalate to the board.

## Credential Setup (Board Action)

If `~/.paperclip/gmail/` does not exist or is empty:

1. Board creates: `mkdir -p ~/.paperclip/gmail/`
2. Board copies OAuth2 client credentials: `cp <source>/credentials.json ~/.paperclip/gmail/`
3. Board runs the OAuth2 flow:
   ```bash
   python -c "
   import os
   from google_auth_oauthlib.flow import InstalledAppFlow
   flow = InstalledAppFlow.from_client_secrets_file(
       os.path.expanduser('~/.paperclip/gmail/credentials.json'),
       ['https://www.googleapis.com/auth/gmail.readonly']
   )
   creds = flow.run_local_server(port=8085)
   with open(os.path.expanduser('~/.paperclip/gmail/token.json'), 'w') as f:
       f.write(creds.to_json())
   print('Token saved.')
   "
   ```
4. Verify: `python <skill-path>/scripts/gmail_read.py validate`
