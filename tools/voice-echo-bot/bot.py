# tools/voice-echo-bot/bot.py
"""Voice-Echo Jarvis-Bot: Long-Poll-Loop, Allowlist, Bestätigungs-Flow."""
import os
import sys
import tempfile
import time
import traceback

import config
import transcribe
from telegram_api import Telegram
from paperclip_client import create_issue, derive_title

CONFIRM_PROMPT = "📝 {text}\n\nAls Aufgabe an den CEO senden?"


class BotApp:
    def __init__(self, tg, cfg):
        self.tg = tg
        self.cfg = cfg
        self.candidates = {}

    def _token(self):
        tok = self.cfg["paperclip_token"]
        return tok() if callable(tok) else tok

    def _confirm_markup(self, key):
        return {"inline_keyboard": [[
            {"text": "✅ An CEO senden", "callback_data": "send:" + key},
            {"text": "❌ Verwerfen", "callback_data": "drop:" + key},
        ]]}

    def _offer(self, chat_id, message_id, text):
        text = (text or "").strip()
        if not text:
            self.tg.send_message(chat_id, "Nichts erkannt, bitte erneut.")
            return
        key = "{}:{}".format(chat_id, message_id)
        self.candidates[key] = text
        self.tg.send_message(chat_id, CONFIRM_PROMPT.format(text=text),
                             reply_markup=self._confirm_markup(key))

    def _handle_message(self, msg):
        chat_id = msg["chat"]["id"]
        message_id = msg["message_id"]
        if "voice" in msg or "audio" in msg:
            media = msg.get("voice") or msg.get("audio")
            workdir = tempfile.mkdtemp()
            ogg = os.path.join(workdir, "in.oga")
            try:
                path = self.tg.get_file_path(media["file_id"])
                self.tg.download_file(path, ogg)
                text = transcribe.transcribe(ogg, self.cfg["whisper_model"], workdir=workdir)
            except transcribe.TranscriptionError:
                self.tg.send_message(chat_id, "Transkription fehlgeschlagen, bitte erneut.")
                return
            self._offer(chat_id, message_id, text)
        elif "text" in msg:
            text = msg["text"]
            if text.startswith("/"):
                self.tg.send_message(chat_id,
                                     "Sprich mir eine Aufgabe ein oder tippe sie — ich lege sie beim CEO an.")
                return
            self._offer(chat_id, message_id, text)

    def _handle_callback(self, cbq):
        data = cbq.get("data", "")
        chat_id = cbq["message"]["chat"]["id"]
        action, _, key = data.partition(":")
        text = self.candidates.pop(key, None)
        if text is None:
            self.tg.answer_callback_query(cbq["id"], "Abgelaufen — bitte neu senden.")
            return
        if action == "send":
            try:
                issue = create_issue(self._token(), self.cfg["company_id"],
                                     self.cfg["ceo_agent_id"], derive_title(text), text)
                label = issue.get("shortId") or issue.get("id", "?")
                self.tg.answer_callback_query(cbq["id"], "Gesendet")
                self.tg.send_message(chat_id, "✅ An CEO gesendet: {}".format(label))
            except Exception:  # noqa: BLE001 - Fehler dem Nutzer melden, Text nicht verlieren
                self.candidates[key] = text
                self.tg.answer_callback_query(cbq["id"], "Fehler")
                self.tg.send_message(chat_id, "⚠️ Konnte Issue nicht anlegen, bitte erneut senden.")
        else:  # drop
            self.tg.answer_callback_query(cbq["id"], "Verworfen")
            self.tg.send_message(chat_id, "❌ Verworfen.")

    def handle_update(self, update):
        if "callback_query" in update:
            cbq = update["callback_query"]
            if cbq.get("from", {}).get("id") != self.cfg["allowed_user_id"]:
                return
            self._handle_callback(cbq)
        elif "message" in update:
            msg = update["message"]
            if msg.get("from", {}).get("id") != self.cfg["allowed_user_id"]:
                return
            self._handle_message(msg)

    def run(self):
        # Startup-Drain: alten Rückstau überspringen
        offset = None
        pending = self.tg.get_updates(offset=-1, timeout=0)
        if pending:
            offset = pending[-1]["update_id"] + 1
        while True:
            try:
                for update in self.tg.get_updates(offset=offset, timeout=50):
                    offset = update["update_id"] + 1
                    self.handle_update(update)
            except Exception:  # noqa: BLE001 - Dienst am Leben halten
                traceback.print_exc()
                time.sleep(5)


def build_app():
    env = config.load_env(config.ENV_PATH)
    cfg = {
        "allowed_user_id": int(env["TELEGRAM_ALLOWED_USER_ID"]),
        "company_id": env["WHITESTAG_COMPANY_ID"],
        "ceo_agent_id": env["CEO_AGENT_ID"],
        "whisper_model": os.path.expanduser(env["WHISPER_MODEL"]),
        "paperclip_token": config.load_paperclip_token,  # callable: pro Issue frisch
    }
    tg = Telegram(env["TELEGRAM_BOT_TOKEN"])
    return BotApp(tg, cfg)


if __name__ == "__main__":
    print("voice-echo jarvis-bot startet…", file=sys.stderr)
    build_app().run()
