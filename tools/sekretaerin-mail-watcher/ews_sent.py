"""Legt eine Kopie einer versendeten Mail via EWS in ws@ „Gesendete Elemente" ab.

SMTP-Submission (der Relay) erzeugt keine Sent-Kopie. Dieser Baustein holt das per
Exchange Web Services nach: `CreateItem` mit `MessageDisposition="SaveOnly"` und
Zielordner `sentitems`. **Nicht-fatal** gedacht: Scheitert der Append, ist die Mail
trotzdem längst raus — es fehlt nur die Ablage-Kopie (→ Aufrufer loggt, bricht nicht ab).
"""
from __future__ import annotations
import base64
import html as _html
import urllib.error
import urllib.request
from pathlib import Path

EWS_URL = "https://ews.de2.hostedoffice.ag/EWS/Exchange.asmx"
ENV_FILE = Path.home() / ".whitestag.env"
FROM_DEFAULT = "office@whitestag.ai"
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) WHITESTAG-Luna"
_creds: tuple[str, str] | None = None


def load_creds(env_file: Path = ENV_FILE) -> tuple[str, str]:
    global _creds
    if _creds is None:
        d: dict[str, str] = {}
        for line in Path(env_file).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("export "):
                line = line[7:]
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                d[k.strip()] = v.strip().strip('"').strip("'")
        # EWS_USER steht als NTLM-Domain-Login mit doppeltem Backslash in der
        # .env (DE2\\user); Exchange erwartet einen einfachen (DE2\user).
        user = d["EWS_USER"].replace("\\\\", "\\")
        _creds = (user, d["EWS_PASS"])
    return _creds


def build_soap(*, to: str, subject: str, html: str, from_addr: str = FROM_DEFAULT) -> str:
    """EWS-CreateItem-SOAP (SaveOnly → sentitems). Element-Reihenfolge ist
    schema-relevant: Subject, Body, ToRecipients, From, IsRead."""
    e = _html.escape
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"'
        ' xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
        ' xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">'
        '<soap:Body>'
        '<m:CreateItem MessageDisposition="SaveOnly">'
        '<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId>'
        '<m:Items><t:Message>'
        f'<t:Subject>{e(subject)}</t:Subject>'
        f'<t:Body BodyType="HTML">{e(html)}</t:Body>'
        f'<t:ToRecipients><t:Mailbox><t:EmailAddress>{e(to)}</t:EmailAddress></t:Mailbox></t:ToRecipients>'
        f'<t:From><t:Mailbox><t:EmailAddress>{e(from_addr)}</t:EmailAddress></t:Mailbox></t:From>'
        '<t:IsRead>true</t:IsRead>'
        '</t:Message></m:Items>'
        '</m:CreateItem>'
        '</soap:Body></soap:Envelope>'
    )


def _is_success(xml: str) -> bool:
    return 'ResponseClass="Success"' in xml or "<m:ResponseCode>NoError" in xml


def save_to_sent(*, to: str, subject: str, html: str, from_addr: str = FROM_DEFAULT,
                 opener=urllib.request.urlopen) -> tuple[bool, str]:
    """Legt die Kopie in ws@ „Gesendete Elemente" ab. `opener` injizierbar für Tests."""
    user, pw = load_creds()
    data = build_soap(to=to, subject=subject, html=html, from_addr=from_addr).encode("utf-8")
    req = urllib.request.Request(EWS_URL, data=data, method="POST", headers={
        "Content-Type": "text/xml; charset=utf-8",
        "Authorization": "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode(),
        "User-Agent": _UA,
    })
    try:
        with opener(req, timeout=30) as r:
            text = r.read().decode("utf-8", "replace")
        return _is_success(text), text[:400]
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}"
    except Exception as e:  # noqa: BLE001 — nicht-fatal
        return False, f"{type(e).__name__}: {e}"
