#!/usr/bin/env python3
"""Luna: Antwort rendern -> Freigabe-Queue-Eintrag -> Freigabe-Mail an Walter.

Ersetzt den Draft-Weg von luna-draft-mail.py. Versendet NIE an Externe —
nur die Freigabe-Mail an ws@. Der Versand an den Kunden erfolgt später
deterministisch durch den Approval-Watcher nach Walters 'Okay'."""
from __future__ import annotations
import argparse, json, sys, urllib.request, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path.home() / ".paperclip" / "scripts" / "sekretaerin-mail-watcher"))
import approval_queue as q                      # noqa: E402
import luna_mail_render as render               # noqa: E402

WEBHOOK = "http://localhost:5678/webhook/mailhub/send"
SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
FROM = "office@whitestag.ai"
WALTER = "ws@whitestag.ai"


def _send_approval_mail(token: str, to: str, subject: str, approval_subject: str,
                        rendered_html: str, attachments: list | None = None) -> None:
    banner = (
        '<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:6px;'
        'padding:10px 14px;margin:0 0 20px 0;font-family:Arial,sans-serif;font-size:12px;color:#7a5c00;">'
        f'<strong>Freigabe nötig</strong> — Antworte mit <strong>„Okay"</strong>, um diese Mail an '
        f'<strong>{to}</strong> zu senden. Jede andere Antwort = Korrektur (ich überarbeite).'
        '</div>')
    html = rendered_html.replace('padding:20px;">', 'padding:20px;">' + banner, 1)
    # Inline-Logos auch in der Freigabe-Vorschau mitschicken, damit Walter sie sieht.
    payload = json.dumps({"from": FROM, "to": WALTER, "subject": approval_subject,
                          "text": f"Freigabe #{token}: Antwort an {to} zum Betreff: {subject}",
                          "html": html, "attachments": attachments or []}).encode()
    req = urllib.request.Request(WEBHOOK, data=payload, method="POST",
                                 headers={"Content-Type": "application/json",
                                          "X-Mailhub-Secret": SECRET})
    with urllib.request.urlopen(req, timeout=30) as r:
        if r.status != 200:
            raise RuntimeError(f"Freigabe-Mail fehlgeschlagen: HTTP {r.status}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--area", required=True, choices=list(render.AREAS))
    ap.add_argument("--to", required=True)
    ap.add_argument("--subject", required=True)
    ap.add_argument("--body", required=True)
    ap.add_argument("--original-file", required=True)
    ap.add_argument("--in-reply-to", default="")
    a = ap.parse_args()

    body_md = Path(a.body).read_text(encoding="utf-8")
    rendered_html, attachments = render.render_customer_html(a.area, body_md)
    token = q.gen_token()
    approval_subject = f"[Freigabe #{token}] AW: {a.subject} → an {a.to}"
    # Queue-Eintrag zuerst (Versand-Quelle), dann Freigabe-Mail.
    q.save({
        "token": token, "status": "pending", "to": a.to, "area": a.area,
        "subject": a.subject, "body_md": body_md, "rendered_html": rendered_html,
        "attachments": attachments,
        "in_reply_to": a.in_reply_to, "original_mail_file": a.original_file,
        "approval_subject": approval_subject,
        "created": __import__("datetime").datetime.now().isoformat(), "sent": None,
    })
    _send_approval_mail(token, a.to, a.subject, approval_subject, rendered_html, attachments)
    print(f"OK Freigabe #{token} → Walter (Kunde: {a.to})")


if __name__ == "__main__":
    main()
