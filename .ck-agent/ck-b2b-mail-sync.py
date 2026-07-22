#!/usr/bin/env python3
"""CK B2B mail sync — IMAP all-folders → EspoCRM Email + external-send detection.

Polls alan@treshermanos.ch (or configured mailbox) over IMAP, walks every selectable folder
(Inbox, Sent, Drafts, …), upserts missing messages into EspoCRM as Email records, and flags
outbound mail that was NOT sent by the CK system (phone, Espo UI compose, etc.).

Stdlib only. Invoked by the plugin job ck.b2b-mail-sync; prints one JSON object to stdout.
"""
from __future__ import annotations

import email
import email.utils
import imaplib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.header import decode_header
from pathlib import Path

B2B_ADDR = "alan@treshermanos.ch"
OURS = re.compile(r"treshermanos|divinocigars", re.I)
DEFAULT_ENV = os.environ.get("CK_B2B_MAIL_ENV") or os.environ.get(
    "CK_B2B_MAIL_ENV_FILE",
    "/work/.ck-secrets/b2b-mail.env",
)
DEFAULT_ESPO = os.environ.get("CK_ESPO_BASE", "http://127.0.0.1:8085/api/v1")
DEFAULT_ESPO_KEY_FILE = os.environ.get(
    "CK_ESPO_KEY_FILE",
    "/work/.ck-secrets/espo.key",
)

_FOLDER_ROLE_ATTRS = {
    "\\Sent": "sent",
    "\\Drafts": "drafts",
    "\\Trash": "trash",
    "\\Junk": "junk",
    "\\Archive": "archive",
}
_FOLDER_NAME_HINTS = {
    "sent": ["sent", "gesendet", "envoy", "inviati"],
    "drafts": ["draft", "entwü", "entwu", "brouillon", "bozze"],
    "trash": ["trash", "papierkorb", "corbeille", "cestino", "deleted"],
    "junk": ["junk", "spam", "unerwün", "pourriel"],
    "archive": ["archive", "archiv"],
}


def load_env(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError as e:
        sys.stderr.write(f"[ck-b2b-mail-sync] cannot read env {path}: {e}\n")
    return out


def decode_hdr(raw) -> str:
    if raw is None:
        return ""
    parts = decode_header(raw)
    out = ""
    for txt, enc in parts:
        if isinstance(txt, bytes):
            try:
                out += txt.decode(enc or "utf-8", "replace")
            except Exception:
                out += txt.decode("utf-8", "replace")
        else:
            out += txt
    return out


def first_address(s: str) -> str:
    m = re.search(r"([a-z0-9._%+\-]+@[a-z0-9.\-]+)", s or "", re.I)
    return m.group(0).lower() if m else ""


def parse_list_line(line) -> tuple[list[str], str]:
    if isinstance(line, bytes):
        line = line.decode("utf-8", "replace")
    m = re.match(r'\(([^)]*)\)\s+("[^"]*"|\S+)\s+("(?:[^"\\]|\\.)*"|\S+)\s*$', line)
    if not m:
        return [], ""
    attrs = m.group(1).split()
    name = m.group(3)
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1].replace('\\"', '"')
    return attrs, name


def list_folders(M: imaplib.IMAP4_SSL) -> list[dict]:
    typ, data = M.list()
    out = []
    for line in data or []:
        attrs, name = parse_list_line(line)
        if not name or "\\Noselect" in attrs:
            continue
        role = "inbox" if name.upper() == "INBOX" else "other"
        for a in attrs:
            if a in _FOLDER_ROLE_ATTRS:
                role = _FOLDER_ROLE_ATTRS[a]
                break
        if role == "other":
            low = name.lower()
            for r, hints in _FOLDER_NAME_HINTS.items():
                if any(h in low for h in hints):
                    role = r
                    break
        out.append({"name": name, "role": role})
    return out


def extract_body(msg: email.message.Message) -> str:
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and "attachment" not in str(
                part.get("Content-Disposition", "")
            ):
                payload = part.get_payload(decode=True)
                if payload:
                    body = payload.decode(part.get_content_charset() or "utf-8", "replace")
                    break
        if not body:
            for part in msg.walk():
                if part.get_content_type() == "text/html":
                    payload = part.get_payload(decode=True)
                    if payload:
                        html = payload.decode(part.get_content_charset() or "utf-8", "replace")
                        body = re.sub(r"<[^>]+>", " ", html)
                        break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            body = payload.decode(msg.get_content_charset() or "utf-8", "replace")
    return re.sub(r"\s+", " ", body).strip()


def parse_date(hdr: str) -> str | None:
    if not hdr:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(hdr)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


class Espo:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/")
        self.key = key

    def req(self, method: str, path: str, body=None):
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={"X-Api-Key": self.key, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode()
                return json.loads(text) if text else {}
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:300]
            raise RuntimeError(f"Espo {method} {path} -> {e.code} {err}") from e

    def list_emails(self, max_size=200):
        return self.req(
            "GET",
            f"/Email?select=id,name,fromString,to,dateSent,messageId,status&orderBy=dateSent&order=desc&maxSize={max_size}",
        )

    def find_by_message_id(self, message_id: str, cache: dict) -> str | None:
        if not message_id:
            return None
        mid = message_id.strip().lower()
        if mid in cache:
            return cache[mid]
        return None

    def create_email(self, attrs: dict) -> str:
        em = self.req("POST", "/Email", attrs)
        return str(em.get("id") or "")

    def list_accounts(self, max_size=200):
        return self.req(
            "GET",
            f"/Account?select=id,name,emailAddress&maxSize={max_size}",
        )


def build_message_id_cache(espo: Espo) -> dict[str, str]:
    cache: dict[str, str] = {}
    try:
        res = espo.list_emails(300)
        for row in res.get("list") or []:
            mid = str(row.get("messageId") or "").strip().lower()
            if mid:
                cache[mid] = str(row.get("id") or "")
    except Exception as e:
        sys.stderr.write(f"[ck-b2b-mail-sync] espo list warning: {e}\n")
    return cache


def account_by_email(accounts: list, addr: str) -> dict | None:
    if not addr:
        return None
    addr = addr.lower()
    for a in accounts:
        if str(a.get("emailAddress") or "").lower() == addr:
            return a
    return None


def is_outbound(role: str, from_addr: str, mailbox: str) -> bool:
    if role == "sent":
        return True
    return mailbox.lower() in (from_addr or "").lower() or OURS.search(from_addr or "")


def sync_folder(
    M: imaplib.IMAP4_SSL,
    folder: dict,
    mailbox: str,
    espo: Espo,
    msg_cache: dict,
    accounts: list,
    system_email_ids: set,
    limit: int,
) -> dict:
    name = folder["name"]
    role = folder["role"]
    stats = {
        "folder": name,
        "role": role,
        "scanned": 0,
        "inserted": 0,
        "skipped_existing": 0,
        "external_sends": [],
    }
    try:
        M.select(f'"{name}"' if " " in name else name, readonly=True)
    except Exception as e:
        stats["error"] = str(e)[:120]
        return stats

    # Recent window first — full ALL on a large Sent folder is too slow for a 15-min cron.
    typ, data = M.uid("search", None, "SINCE", "01-Jun-2026")
    uids = data[0].split() if data and data[0] else []
    if not uids:
        typ, data = M.uid("search", None, "ALL")
        uids = data[0].split() if data and data[0] else []
    uids = uids[-limit:] if uids else []

    for uid in reversed(uids):
        stats["scanned"] += 1
        typ, d = M.uid("fetch", uid, "(RFC822)")
        if not d or not d[0] or not isinstance(d[0], tuple):
            continue
        msg = email.message_from_bytes(d[0][1])
        message_id = str(msg.get("Message-ID") or "").strip()
        if message_id and msg_cache.get(message_id.lower()):
            stats["skipped_existing"] += 1
            continue

        from_raw = decode_hdr(msg.get("From"))
        to_raw = decode_hdr(msg.get("To"))
        subject = decode_hdr(msg.get("Subject")) or "(no subject)"
        from_addr = first_address(from_raw)
        to_addr = first_address(to_raw)
        body = extract_body(msg)
        date_sent = parse_date(decode_hdr(msg.get("Date")))

        outbound = is_outbound(role, from_addr, mailbox)
        parent = None
        if outbound:
            parent = account_by_email(accounts, to_addr)
        else:
            parent = account_by_email(accounts, from_addr)

        status = "Sent" if outbound else "Received"
        attrs = {
            "name": subject[:250],
            "from": from_raw[:250] or from_addr,
            "to": to_raw[:500] or to_addr,
            "body": body[:50000] or subject,
            "bodyPlain": body[:50000] or subject,
            "isHtml": False,
            "status": status,
            "dateSent": date_sent,
            "messageId": message_id or None,
            "assignedUserId": "6a3b607a33b6f5c55",
        }
        if parent:
            attrs["parentType"] = "Account"
            attrs["parentId"] = parent["id"]

        try:
            eid = espo.create_email(attrs)
            if message_id:
                msg_cache[message_id.lower()] = eid
            stats["inserted"] += 1

            if outbound and role == "sent":
                is_system = eid in system_email_ids
                if not is_system:
                    stats["external_sends"].append(
                        {
                            "espo_email_id": eid,
                            "message_id": message_id,
                            "to": to_addr,
                            "to_name": to_raw,
                            "from": from_addr,
                            "subject": subject,
                            "date_sent": date_sent,
                            "body_snippet": body[:1500],
                            "account_id": parent["id"] if parent else None,
                            "account_name": parent.get("name") if parent else None,
                            "imap_folder": name,
                            "imap_uid": uid.decode() if isinstance(uid, bytes) else str(uid),
                        }
                    )
        except Exception as e:
            stats.setdefault("errors", []).append(str(e)[:120])

    return stats


def main():
    env_path = os.environ.get("CK_B2B_MAIL_ENV", DEFAULT_ENV)
    espo_base = os.environ.get("CK_ESPO_BASE", DEFAULT_ESPO)
    espo_key_file = os.environ.get("CK_ESPO_KEY_FILE", DEFAULT_ESPO_KEY_FILE)
    limit = int(os.environ.get("CK_B2B_MAIL_SYNC_LIMIT", "80"))

    cfg = load_env(env_path)
    mailbox = cfg.get("EMAIL_ADDRESS") or B2B_ADDR
    user = cfg.get("EMAIL_USERNAME") or mailbox
    password = cfg.get("EMAIL_PASSWORD") or ""
    host = cfg.get("EMAIL_IMAP_HOST") or "mail.infomaniak.com"
    port = int(cfg.get("EMAIL_IMAP_PORT") or "993")

    if not password:
        print(json.dumps({"ok": False, "error": f"no EMAIL_PASSWORD in {env_path}"}))
        return 1

    try:
        espo_key = Path(espo_key_file).read_text().strip()
    except OSError as e:
        print(json.dumps({"ok": False, "error": f"cannot read espo key: {e}"}))
        return 1

    system_ids = set()
    system_ids_raw = os.environ.get("CK_SYSTEM_EMAIL_IDS", "")
    if system_ids_raw:
        system_ids = {x.strip() for x in system_ids_raw.split(",") if x.strip()}

    espo = Espo(espo_base, espo_key)
    msg_cache = build_message_id_cache(espo)
    accounts = []
    try:
        accounts = (espo.list_accounts(200).get("list")) or []
    except Exception as e:
        sys.stderr.write(f"[ck-b2b-mail-sync] account list warning: {e}\n")

    M = imaplib.IMAP4_SSL(host, port)
    M.sock.settimeout(30)
    result = {
        "ok": True,
        "mailbox": mailbox,
        "synced_at": datetime.now(timezone.utc).isoformat(),
        "folders": [],
        "external_sends": [],
        "totals": {"scanned": 0, "inserted": 0, "skipped_existing": 0},
    }
    try:
        M.login(user, password)
        folders = list_folders(M)
        for folder in folders:
            if folder["role"] in ("trash", "junk"):
                continue
            fs = sync_folder(
                M, folder, mailbox, espo, msg_cache, accounts, system_ids, limit
            )
            result["folders"].append(fs)
            result["totals"]["scanned"] += fs.get("scanned", 0)
            result["totals"]["inserted"] += fs.get("inserted", 0)
            result["totals"]["skipped_existing"] += fs.get("skipped_existing", 0)
            for ext in fs.get("external_sends") or []:
                result["external_sends"].append(ext)
    finally:
        try:
            M.logout()
        except Exception:
            pass

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())