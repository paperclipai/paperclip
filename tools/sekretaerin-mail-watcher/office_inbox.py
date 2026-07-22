"""Robuste Okay-Erkennung: liest Walters Freigabe-Antworten direkt aus dem
office@-Posteingang (Hetzner-IMAP).

Warum: Walter antwortet auf die Freigabe-Mail (Absender office@), die Antwort
landet also **direkt in office@'s Posteingang** — unabhängig davon, ob sein
ws@-„Gesendete Elemente" eine Kopie behält oder der Vault-Sync sie zieht. Das ist
der zuverlässige Erkennungsweg; der bisherige Umweg über den ws@-Sent-Sync verpasst
Antworten, wenn der Sent-Ordner keine Kopie bekommt.

Bearbeitete UIDs werden lokal gemerkt (`~/.paperclip/state/office-approval-uids.json`),
statt Walters Mailbox-Status (\\Seen) zu verändern.
"""
from __future__ import annotations
import html as _html
import imaplib
import json
import re
from email import message_from_bytes
from email.header import decode_header
from pathlib import Path

ENV_FILE = Path.home() / ".whitestag.env"
STATE = Path.home() / ".paperclip" / "state" / "office-approval-uids.json"
TOKEN_RE = re.compile(r"\[Freigabe #([A-Z2-7]{4})\]")
WALTER_MARKERS = ("schonenbroch", "schönenbröch", "walter", "oubifb")

# Zitat-/Referenz-Container, ab denen der zitierte Ursprung beginnt (HTML).
_QUOTE_HTML = (
    'id="mail-editor-reference-message-container"',
    'id="divrplyfwdmsg"',
    "<blockquote",
    'class="gmail_quote"',
    "-----ursprüngliche nachricht-----",
    "-----original message-----",
)


def _env(name: str, env_file: Path = ENV_FILE) -> str:
    for line in Path(env_file).read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("export "):
            s = s[7:]
        if s.startswith(name + "="):
            v = s.split("=", 1)[1].strip()
            if v and v[0] in "\"'" and v[-1] == v[0]:
                v = v[1:-1]
            return v
    raise KeyError(name)


def load_creds(env_file: Path = ENV_FILE) -> tuple[str, str, str]:
    return (_env("OFFICE_IMAP_HOST", env_file), _env("OFFICE_IMAP_USER", env_file),
            _env("OFFICE_IMAP_PASS", env_file))


def html_to_text(body: str) -> str:
    """HTML-Mailbody → oberster Antworttext (Zitat/Referenz abgeschnitten, Tags weg)."""
    low = body.lower()
    cut = len(body)
    for marker in _QUOTE_HTML:
        i = low.find(marker)
        if i != -1:
            cut = min(cut, i)
    frag = body[:cut]
    frag = re.sub(r"<[^>]*$", "", frag)  # angeschnittenes Öffnungs-Tag am Ende weg
    # Blockelemente → Zeilenumbruch, dann Tags entfernen.
    frag = re.sub(r"(?i)<\s*(br|/div|/p|/tr|/li)\s*/?>", "\n", frag)
    frag = re.sub(r"<[^>]+>", "", frag)
    text = _html.unescape(frag)
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln).strip()


def extract_token(subject: str) -> str | None:
    m = TOKEN_RE.search(subject or "")
    return m.group(1) if m else None


def _safe_decode(b: bytes, charset: str | None) -> str:
    for enc in (charset, "utf-8", "latin1"):
        if not enc:
            continue
        try:
            return b.decode(enc, "replace")
        except LookupError:  # z.B. 'unknown-8bit' ist kein Python-Codec
            continue
    return b.decode("utf-8", "replace")


def _decode(s: str | None) -> str:
    if not s:
        return ""
    return "".join(_safe_decode(t, e) if isinstance(t, bytes) else t
                   for t, e in decode_header(s))


def _body_text(msg) -> str:
    """Reiner Antworttext: text/plain bevorzugt, sonst text/html→Text."""
    plain = html = ""
    if msg.is_multipart():
        for p in msg.walk():
            ct = p.get_content_type()
            if ct == "text/plain" and not plain:
                plain = _safe_decode(p.get_payload(decode=True), p.get_content_charset())
            elif ct == "text/html" and not html:
                html = _safe_decode(p.get_payload(decode=True), p.get_content_charset())
    else:
        payload = _safe_decode(msg.get_payload(decode=True), msg.get_content_charset())
        if msg.get_content_type() == "text/html":
            html = payload
        else:
            plain = payload
    if plain.strip():
        return plain.strip()
    return html_to_text(html)


def load_processed() -> set[str]:
    if not STATE.exists():
        return set()
    try:
        return set(json.loads(STATE.read_text(encoding="utf-8")).get("uids", []))
    except (json.JSONDecodeError, OSError):
        return set()


def save_processed(uids: set[str]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"uids": sorted(uids)[-500:]}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE)


UNBLOCK_STATE = Path.home() / ".paperclip" / "state" / "office-unblock-uids.json"
_ADDR_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")


def load_processed_unblock() -> set[str]:
    if not UNBLOCK_STATE.exists():
        return set()
    try:
        return set(json.loads(UNBLOCK_STATE.read_text(encoding="utf-8")).get("uids", []))
    except (json.JSONDecodeError, OSError):
        return set()


def save_processed_unblock(uids: set[str]) -> None:
    UNBLOCK_STATE.parent.mkdir(parents=True, exist_ok=True)
    tmp = UNBLOCK_STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"uids": sorted(uids)[-500:]}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(UNBLOCK_STATE)


def _parse_unblock(subject: str, body: str) -> str | None:
    """Adresse aus einem 'Entsperren <adresse>'-Kommando (Betreff ODER erste Body-Zeile)."""
    first_line = (body or "").split("\n", 1)[0]
    for src in (subject or "", first_line):
        s = src.strip()
        if s.lower().startswith("entsperren"):
            m = _ADDR_RE.search(s)
            if m:
                return m.group(0).lower()
    return None


def fetch_unblock_commands(processed: set[str], *, imap=None) -> list[dict]:
    """Walters 'Entsperren <adresse>'-Mails aus office@-INBOX, noch nicht bearbeitet.
    Liefert [{uid, addr}]. `imap` injizierbar für Tests."""
    host, user, pw = load_creds()
    M = imap or imaplib.IMAP4_SSL(host, 993)
    if imap is None:
        M.login(user, pw)
    M.select("INBOX")
    typ, data = M.uid("search", None, '(TEXT "Entsperren")')
    out: list[dict] = []
    for uid in data[0].split():
        uid_s = uid.decode() if isinstance(uid, bytes) else str(uid)
        if uid_s in processed:
            continue
        typ, dd = M.uid("fetch", uid, "(RFC822)")
        if not dd or not dd[0]:
            continue
        msg = message_from_bytes(dd[0][1])
        frm = _decode(msg.get("From", "")).lower()
        if not any(m in frm for m in WALTER_MARKERS):
            continue
        addr = _parse_unblock(_decode(msg.get("Subject", "")), _body_text(msg))
        if not addr:
            continue
        out.append({"uid": uid_s, "addr": addr})
    if imap is None:
        M.logout()
    return out


def fetch_approval_replies(processed: set[str], *, imap=None) -> list[dict]:
    """Freigabe-Antworten von Walter aus office@-INBOX, die noch nicht bearbeitet
    wurden. Liefert [{uid, token, body, subject}]. `imap` injizierbar für Tests."""
    host, user, pw = load_creds()
    M = imap or imaplib.IMAP4_SSL(host, 993)
    if imap is None:
        M.login(user, pw)
    M.select("INBOX")
    typ, data = M.uid("search", None, '(SUBJECT "Freigabe #")')
    out: list[dict] = []
    for uid in data[0].split():
        uid_s = uid.decode() if isinstance(uid, bytes) else str(uid)
        if uid_s in processed:
            continue
        typ, dd = M.uid("fetch", uid, "(RFC822)")
        if not dd or not dd[0]:
            continue
        msg = message_from_bytes(dd[0][1])
        frm = _decode(msg.get("From", "")).lower()
        subject = _decode(msg.get("Subject", ""))
        token = extract_token(subject)
        if not token or not any(m in frm for m in WALTER_MARKERS):
            continue
        out.append({"uid": uid_s, "token": token, "body": _body_text(msg), "subject": subject})
    if imap is None:
        M.logout()
    return out
