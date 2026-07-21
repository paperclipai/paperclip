# tools/voice-echo-bot/bot.py
"""Jarvis-Bot: Mehrmandanten-Eingang, Reply→Kommentar, CEO-Event-Poll (stdlib only)."""
import os
import re
import shutil
import sys
import tempfile
import time
import traceback

import config
import state
import tenants as tenants_mod
import transcribe
import notifier
from telegram_api import Telegram
from paperclip_client import (create_issue, derive_title, add_comment,
                              find_issue_by_identifier, list_issues, resolve_label_id)

CONFIRM_PROMPT = "📝 {text}\n\nAls Aufgabe an den CEO senden?"
IDENT_RE = re.compile(r"([A-Z]{2,5}-\d+)")


class BotApp:
    def __init__(self, tg, cfg):
        self.tg = tg
        self.cfg = cfg
        self.candidates = {}
        self.seen = set()
        self._seeded = True

    def _token(self):
        tok = self.cfg["paperclip_token"]
        return tok() if callable(tok) else tok

    # ---- Eingang / Dispatcher ----
    def handle_update(self, update):
        if "callback_query" in update:
            cbq = update["callback_query"]
            tenant = tenants_mod.resolve_tenant(self.cfg["tenants"], cbq.get("from", {}).get("id"))
            if tenant:
                self._handle_callback(tenant, cbq)
        elif "message" in update:
            msg = update["message"]
            tenant = tenants_mod.resolve_tenant(self.cfg["tenants"], msg.get("from", {}).get("id"))
            if tenant:
                self._handle_message(tenant, msg)

    def _extract_text(self, msg):
        """Voice -> Whisper (mit Cleanup) oder Textnachricht; None bei Transkriptionsfehler."""
        if "voice" in msg or "audio" in msg:
            media = msg.get("voice") or msg.get("audio")
            workdir = tempfile.mkdtemp()
            ogg = os.path.join(workdir, "in.oga")
            try:
                path = self.tg.get_file_path(media["file_id"])
                self.tg.download_file(path, ogg)
                return transcribe.transcribe(ogg, self.cfg["whisper_model"], workdir=workdir)
            except transcribe.TranscriptionError:
                self.tg.send_message(msg["chat"]["id"], "Transkription fehlgeschlagen, bitte erneut.")
                return None
            finally:
                shutil.rmtree(workdir, ignore_errors=True)
        return msg.get("text")

    def _handle_message(self, tenant, msg):
        reply_to = msg.get("reply_to_message")
        if reply_to:
            m = IDENT_RE.search(reply_to.get("text") or "")
            if m:
                self._handle_reply(tenant, msg, m.group(1))
                return
        text = self._extract_text(msg)
        if text is None:
            return
        if isinstance(text, str) and text.startswith("/"):
            self.tg.send_message(msg["chat"]["id"],
                                 "Sprich mir eine Aufgabe ein oder tippe sie — ich lege sie beim CEO an.")
            return
        self._offer(tenant, msg["chat"]["id"], msg["message_id"], text)

    # ---- Reply -> Kommentar ----
    def _handle_reply(self, tenant, msg, identifier):
        chat_id = msg["chat"]["id"]
        text = self._extract_text(msg)
        if text is None:
            return
        token = self._token()
        issue = find_issue_by_identifier(token, tenant["company_id"], identifier)
        if not issue:
            self.tg.send_message(chat_id, "Konnte kein passendes Issue ({}) finden.".format(identifier))
            return
        try:
            add_comment(token, issue["id"], text, resume=True)
            self.tg.send_message(chat_id, "✅ Antwort an CEO ({}) gesendet.".format(identifier))
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            self.tg.send_message(chat_id, "⚠️ Konnte die Antwort nicht senden, bitte erneut.")

    # ---- Issue-Erstellung (Bestätigungs-Flow) ----
    def _confirm_markup(self, key):
        return {"inline_keyboard": [[
            {"text": "✅ An CEO senden", "callback_data": "send:" + key},
            {"text": "❌ Verwerfen", "callback_data": "drop:" + key},
        ]]}

    def _offer(self, tenant, chat_id, message_id, text):
        text = (text or "").strip()
        if not text:
            self.tg.send_message(chat_id, "Nichts erkannt, bitte erneut.")
            return
        key = "{}:{}".format(chat_id, message_id)
        self.candidates[key] = {"text": text, "company_id": tenant["company_id"],
                                "ceo_agent_id": tenant["ceo_agent_id"]}
        self.tg.send_message(chat_id, CONFIRM_PROMPT.format(text=text), reply_markup=self._confirm_markup(key))

    def _handle_callback(self, tenant, cbq):
        data = cbq.get("data", "")
        chat_id = cbq["message"]["chat"]["id"]
        action, _, key = data.partition(":")
        cand = self.candidates.pop(key, None)
        if cand is None:
            self.tg.answer_callback_query(cbq["id"], "Abgelaufen — bitte neu senden.")
            return
        if action == "send":
            try:
                issue = create_issue(self._token(), cand["company_id"], cand["ceo_agent_id"],
                                     derive_title(cand["text"]), cand["text"])
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                self.candidates[key] = cand
                self.tg.answer_callback_query(cbq["id"], "Fehler")
                self.tg.send_message(chat_id, "⚠️ Konnte Issue nicht anlegen, bitte erneut senden.")
                return
            label = issue.get("identifier") or issue.get("id", "?")
            try:
                self.tg.answer_callback_query(cbq["id"], "Gesendet")
                self.tg.send_message(chat_id, "✅ An CEO gesendet: {}".format(label))
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        else:
            self.tg.answer_callback_query(cbq["id"], "Verworfen")
            self.tg.send_message(chat_id, "❌ Verworfen.")

    # ---- Rückkanal-Poll ----
    def _format_push(self, ev):
        i = ev["issue"]
        ident = i.get("identifier") or (i.get("id") or "?")[:8]
        title = i.get("title") or "(ohne Titel)"
        if ev["kind"] == "done":
            return "✅ Erledigt — {}: {}".format(ident, title)
        return ("🟠 Entscheidung benötigt — {}: {}\n\n"
                "↩️ Antworte auf diese Nachricht (Sprache/Text), um dem CEO zu antworten.").format(ident, title)

    def poll_tenants(self):
        token = self._token()
        # Snapshot: pro Poll-Durchlauf dürfen sich Mandanten mit identischen
        # Issue-IDs (unterschiedliche Companies) nicht gegenseitig als
        # "schon gesehen" markieren.
        base_seen = set(self.seen)
        for uid, tenant in self.cfg["tenants"].items():
            try:
                label_id = resolve_label_id(token, tenant["company_id"], self.cfg["decision_label"])
                issues = list_issues(token, tenant["company_id"])
                events, keys = notifier.collect_events(issues, label_id, base_seen)
                if self._seeded:
                    for ev in events:
                        try:
                            self.tg.send_message(int(uid), self._format_push(ev))
                        except Exception:  # noqa: BLE001
                            traceback.print_exc()
                self.seen.update(keys)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        state.save_state(self.cfg["state_path"], self.seen)
        self._seeded = True

    def _drain(self):
        offset = None
        pending = self.tg.get_updates(offset=-1, timeout=0)
        if pending:
            offset = pending[-1]["update_id"] + 1
        return offset

    def run(self):
        offset = self._drain()
        last_poll = 0.0
        while True:
            try:
                for update in self.tg.get_updates(offset=offset, timeout=config.LONGPOLL_TIMEOUT_SEC):
                    offset = update["update_id"] + 1
                    self.handle_update(update)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
                time.sleep(5)
            now = time.monotonic()
            if now - last_poll >= self.cfg["poll_interval"]:
                self.poll_tenants()
                last_poll = now


def build_app():
    env = config.load_env(config.ENV_PATH)
    cfg = {
        "tenants": tenants_mod.load_tenants(config.TENANTS_PATH),
        "paperclip_token": config.load_paperclip_token,
        "whisper_model": os.path.expanduser(env["WHISPER_MODEL"]),
        "decision_label": config.DECISION_LABEL,
        "poll_interval": config.POLL_INTERVAL_SEC,
        "state_path": config.STATE_PATH,
    }
    app = BotApp(Telegram(env["TELEGRAM_BOT_TOKEN"]), cfg)
    app.seen = state.load_state(config.STATE_PATH)
    app._seeded = os.path.exists(config.STATE_PATH)
    return app


if __name__ == "__main__":
    print("voice-echo jarvis-bot startet…", file=sys.stderr)
    build_app().run()
