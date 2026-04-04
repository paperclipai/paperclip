#!/usr/bin/env python3
"""Shared Gmail API read-only operations for DSpot agents.

Self-contained script for Gmail API access. Supports search, message retrieval,
header extraction, attachment download, and token validation.

Credential resolution order:
  1. GMAIL_CREDENTIALS_DIR env var
  2. ~/.paperclip/gmail/

Requires: google-auth, google-auth-oauthlib, google-api-python-client

Usage:
    python gmail_read.py validate                           # Verify credentials work
    python gmail_read.py search "from:vendor@example.com"   # Search messages
    python gmail_read.py search "subject:invoice after:2026/01/01" --max 20
    python gmail_read.py get <message_id>                   # Get full message
    python gmail_read.py headers <message_id>               # Get headers only
    python gmail_read.py list-recent [--max 10]             # List recent messages
    python gmail_read.py labels                             # List all labels
    python gmail_read.py download-attachment <message_id> <attachment_id> <output_path>
"""

import argparse
import json
import os
import sys
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

# --- Credential Resolution ---

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
]

# Full-access scopes (used if token was created with broader scopes)
FULL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.send",
]


def _find_credentials_dir():
    """Find the credentials directory, checking env var then default paths."""
    env_dir = os.environ.get("GMAIL_CREDENTIALS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return env_dir

    default = os.path.join(Path.home(), ".paperclip", "gmail")
    if os.path.isdir(default):
        return default

    return None


def _get_credentials(creds_dir):
    """Load and refresh OAuth2 credentials."""
    token_path = os.path.join(creds_dir, "token.json")
    credentials_path = os.path.join(creds_dir, "credentials.json")

    if not os.path.exists(token_path):
        print(f"Error: token.json not found at {token_path}", file=sys.stderr)
        print("Run the OAuth2 flow first (see gmail-api skill docs).", file=sys.stderr)
        return None

    # Try loading with readonly scopes first, then full scopes
    creds = None
    for scopes in [SCOPES, FULL_SCOPES]:
        try:
            creds = Credentials.from_authorized_user_file(token_path, scopes)
            break
        except Exception:
            continue

    if not creds:
        # Load without scope validation
        creds = Credentials.from_authorized_user_file(token_path)

    if not creds.valid:
        if creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                # Save refreshed token back
                with open(token_path, "w") as f:
                    f.write(creds.to_json())
            except Exception as e:
                print(f"Token refresh failed: {e}", file=sys.stderr)
                print("The OAuth2 token may need re-authorization.", file=sys.stderr)
                return None
        else:
            print("Token is invalid and cannot be refreshed.", file=sys.stderr)
            return None

    return creds


def _get_service(creds_dir):
    """Build authenticated Gmail API service."""
    creds = _get_credentials(creds_dir)
    if not creds:
        sys.exit(1)
    return build("gmail", "v1", credentials=creds)


# --- Commands ---

def cmd_validate(creds_dir):
    """Validate credentials and print account info."""
    service = _get_service(creds_dir)
    profile = service.users().getProfile(userId="me").execute()
    print(json.dumps({
        "status": "ok",
        "email": profile.get("emailAddress"),
        "messagesTotal": profile.get("messagesTotal"),
        "threadsTotal": profile.get("threadsTotal"),
        "credentialsDir": creds_dir,
    }, indent=2))


def cmd_search(creds_dir, query, max_results=10):
    """Search messages and return summaries."""
    service = _get_service(creds_dir)
    messages = []
    page_token = None

    while len(messages) < max_results:
        batch_size = min(100, max_results - len(messages))
        result = service.users().messages().list(
            userId="me", q=query, maxResults=batch_size, pageToken=page_token
        ).execute()
        batch = result.get("messages", [])
        messages.extend(batch)
        page_token = result.get("nextPageToken")
        if not page_token or not batch:
            break

    messages = messages[:max_results]

    # Fetch headers for each message
    results = []
    for msg_stub in messages:
        msg = service.users().messages().get(
            userId="me", id=msg_stub["id"], format="metadata",
            metadataHeaders=["From", "To", "Subject", "Date"]
        ).execute()
        headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
        results.append({
            "id": msg["id"],
            "threadId": msg["threadId"],
            "from": headers.get("From", ""),
            "to": headers.get("To", ""),
            "subject": headers.get("Subject", ""),
            "date": headers.get("Date", ""),
            "snippet": msg.get("snippet", ""),
            "labelIds": msg.get("labelIds", []),
        })

    print(json.dumps({"query": query, "count": len(results), "messages": results}, indent=2))


def cmd_get(creds_dir, message_id):
    """Get a full message by ID."""
    service = _get_service(creds_dir)
    msg = service.users().messages().get(userId="me", id=message_id, format="full").execute()

    headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
    body_text = _extract_body(msg.get("payload", {}))
    attachments = _list_attachments(msg.get("payload", {}))

    result = {
        "id": msg["id"],
        "threadId": msg["threadId"],
        "from": headers.get("From", ""),
        "to": headers.get("To", ""),
        "subject": headers.get("Subject", ""),
        "date": headers.get("Date", ""),
        "snippet": msg.get("snippet", ""),
        "labelIds": msg.get("labelIds", []),
        "body": body_text[:5000],  # Truncate for safety
        "attachments": attachments,
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_headers(creds_dir, message_id):
    """Get message headers only (lightweight)."""
    service = _get_service(creds_dir)
    msg = service.users().messages().get(
        userId="me", id=message_id, format="metadata"
    ).execute()
    headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
    result = {
        "id": msg["id"],
        "threadId": msg["threadId"],
        "headers": headers,
        "snippet": msg.get("snippet", ""),
        "labelIds": msg.get("labelIds", []),
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_list_recent(creds_dir, max_results=10):
    """List most recent messages."""
    cmd_search(creds_dir, "", max_results)


def cmd_labels(creds_dir):
    """List all Gmail labels."""
    service = _get_service(creds_dir)
    results = service.users().labels().list(userId="me").execute()
    labels = results.get("labels", [])
    labels.sort(key=lambda l: l.get("name", ""))
    print(json.dumps({"count": len(labels), "labels": labels}, indent=2))


def cmd_download_attachment(creds_dir, message_id, attachment_id, output_path):
    """Download an attachment to a local file."""
    import base64

    service = _get_service(creds_dir)
    attachment = service.users().messages().attachments().get(
        userId="me", messageId=message_id, id=attachment_id
    ).execute()

    data = base64.urlsafe_b64decode(attachment["data"])

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)

    print(json.dumps({
        "status": "ok",
        "messageId": message_id,
        "attachmentId": attachment_id,
        "outputPath": str(out.resolve()),
        "size": len(data),
    }, indent=2))


# --- Helpers ---

def _extract_body(payload, prefer="text/plain"):
    """Extract body text from message payload."""
    import base64

    # Simple single-part message
    if payload.get("body", {}).get("data"):
        mime = payload.get("mimeType", "")
        data = base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", errors="replace")
        return data

    # Multipart message
    parts = payload.get("parts", [])
    plain_text = ""
    html_text = ""

    for part in parts:
        mime = part.get("mimeType", "")
        if mime == "text/plain" and part.get("body", {}).get("data"):
            plain_text = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
        elif mime == "text/html" and part.get("body", {}).get("data"):
            html_text = base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", errors="replace")
        elif mime.startswith("multipart/"):
            # Recurse into nested multipart
            nested = _extract_body(part, prefer)
            if nested:
                return nested

    if prefer == "text/plain" and plain_text:
        return plain_text
    if html_text:
        # Strip HTML tags for a rough text version
        import re
        text = re.sub(r'<[^>]+>', '', html_text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text
    return plain_text or ""


def _list_attachments(payload):
    """List attachments in a message payload."""
    attachments = []
    parts = payload.get("parts", [])
    for part in parts:
        filename = part.get("filename", "")
        if filename:
            attachments.append({
                "filename": filename,
                "mimeType": part.get("mimeType", ""),
                "size": part.get("body", {}).get("size", 0),
                "attachmentId": part.get("body", {}).get("attachmentId", ""),
            })
        # Recurse into nested parts
        if part.get("parts"):
            attachments.extend(_list_attachments(part))
    return attachments


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="Gmail API read-only operations")
    parser.add_argument("--credentials-dir", help="Override credentials directory")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # validate
    subparsers.add_parser("validate", help="Validate credentials")

    # search
    p_search = subparsers.add_parser("search", help="Search messages")
    p_search.add_argument("query", help="Gmail search query")
    p_search.add_argument("--max", type=int, default=10, help="Max results")

    # get
    p_get = subparsers.add_parser("get", help="Get full message")
    p_get.add_argument("message_id", help="Gmail message ID")

    # headers
    p_headers = subparsers.add_parser("headers", help="Get message headers")
    p_headers.add_argument("message_id", help="Gmail message ID")

    # list-recent
    p_recent = subparsers.add_parser("list-recent", help="List recent messages")
    p_recent.add_argument("--max", type=int, default=10, help="Max results")

    # labels
    subparsers.add_parser("labels", help="List labels")

    # download-attachment
    p_dl = subparsers.add_parser("download-attachment", help="Download an attachment")
    p_dl.add_argument("message_id", help="Gmail message ID")
    p_dl.add_argument("attachment_id", help="Attachment ID (from 'get' output)")
    p_dl.add_argument("output_path", help="Local file path to save the attachment")

    args = parser.parse_args()

    # Resolve credentials directory
    creds_dir = args.credentials_dir or _find_credentials_dir()
    if not creds_dir:
        print("Error: No credentials directory found.", file=sys.stderr)
        print("Set GMAIL_CREDENTIALS_DIR or place credentials in ~/.paperclip/gmail/", file=sys.stderr)
        sys.exit(1)

    if args.command == "validate":
        cmd_validate(creds_dir)
    elif args.command == "search":
        cmd_search(creds_dir, args.query, args.max)
    elif args.command == "get":
        cmd_get(creds_dir, args.message_id)
    elif args.command == "headers":
        cmd_headers(creds_dir, args.message_id)
    elif args.command == "list-recent":
        cmd_list_recent(creds_dir, args.max)
    elif args.command == "labels":
        cmd_labels(creds_dir)
    elif args.command == "download-attachment":
        cmd_download_attachment(creds_dir, args.message_id, args.attachment_id, args.output_path)


if __name__ == "__main__":
    main()
