# tools/voice-echo-bot/bot.py
"""Jarvis-Bot: Chat-Agent mit Vault-Lookup + CEO-Task-Anlage (stdlib only).

Jede Nachricht ist ein normaler Chat: das lokale LLM (LM Studio) antwortet
direkt. Braucht es echte Daten, gibt es in der ersten Zeile ein Steuer-Token
aus (`LOOKUP <modus>: …` bzw. `ISSUE: <titel> :: <beschreibung>`), das der Bot
prompt-gesteuert auflöst — Vault-Nachschlagen bzw. Issue beim CEO anlegen.
Reply→Kommentar, Antwort-Modus (Text/Voice) und der CEO-Event-Poll bleiben.
"""
import json
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
import tts
import reply_mode
import notifier
import llm
import vault_client
from telegram_api import Telegram
from paperclip_client import (create_issue, derive_title, add_comment,
                              find_issue_by_identifier, list_issues, resolve_label_id)
import jarvis_brain
from jarvis_brain import LOOKUP_RE, ISSUE_RE, parse_control

IDENT_RE = re.compile(r"([A-Z]{2,5}-\d+)")

# Konversations-Historie pro Chat: max. 8 Turns (= 16 Messages) in-memory.
MAX_HISTORY_MESSAGES = 16


class BotApp:
    def __init__(self, tg, cfg):
        self.tg = tg
        self.cfg = cfg
        self.history = {}  # chat_id -> [{"role","content"}, …] (max 8 Turns)
        self.seen = set()
        self._seeded = True

    def _chat_model(self):
        return self.cfg.get("chat_model") or llm.DEFAULT_MODEL

    def _token(self):
        tok = self.cfg["paperclip_token"]
        return tok() if callable(tok) else tok

    # ---- Antwort-Kanal (Text/Voice je Chat) ----
    def _reply(self, chat_id, text, reply_to_message_id=None):
        """Direkte Antwort an den Nutzer gemäß Chat-Antwortmodus.

        voice -> ElevenLabs-TTS + sendVoice; bei TtsError sauberer Fallback
        auf Text + kurzer Hinweis. text (Default) -> send_message wie bisher.
        Gilt nur für direkte Antworten auf Nutzer-Nachrichten/-Aktionen; die
        Rückkanal-Pushes (poll_tenants) bleiben bewusst Text.
        """
        path = self.cfg.get("reply_mode_path")
        if path and reply_mode.get_mode(path, chat_id) == "voice":
            workdir = tempfile.mkdtemp()
            ogg = os.path.join(workdir, "reply.ogg")
            try:
                tts.synthesize(text, self.cfg.get("eleven_api_key"), ogg)
                self.tg.send_voice(chat_id, ogg, reply_to_message_id=reply_to_message_id)
                return
            except tts.TtsError:
                traceback.print_exc()
                self.tg.send_message(chat_id, text)
                self.tg.send_message(chat_id, "⚠️ Sprachausgabe fehlgeschlagen — Antwort als Text.")
                return
            finally:
                shutil.rmtree(workdir, ignore_errors=True)
        self.tg.send_message(chat_id, text)

    # ---- Eingang / Dispatcher ----
    def handle_update(self, update):
        # Der Chat legt Issues jetzt direkt per ISSUE-Token an — es gibt keine
        # Bestätigungs-Buttons mehr, also auch keine callback_query zu bedienen.
        if "message" in update:
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
        # Modus-Befehle (/text, /voice, ggf. mit @botname-Suffix) setzen nur
        # den Antwortmodus des Chats — kein Issue, keine Transkription.
        raw = msg.get("text")
        if isinstance(raw, str) and raw.strip().startswith("/"):
            cmd = raw.strip().split()[0].split("@")[0].lower()
            if cmd == "/voice":
                reply_mode.set_mode(self.cfg["reply_mode_path"], msg["chat"]["id"], "voice")
                self.tg.send_message(msg["chat"]["id"], "🔊 Antworten jetzt als Sprache.")
                return
            if cmd == "/text":
                reply_mode.set_mode(self.cfg["reply_mode_path"], msg["chat"]["id"], "text")
                self.tg.send_message(msg["chat"]["id"], "🔤 Antworten jetzt als Text.")
                return
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
                                 "Schreib oder sprich mir einfach — ich antworte, schlage bei "
                                 "Bedarf im Vault nach und lege auf Wunsch Aufgaben beim CEO an.")
            return
        self._handle_chat(tenant, msg, text)

    # ---- Reply -> Kommentar ----
    def _handle_reply(self, tenant, msg, identifier):
        chat_id = msg["chat"]["id"]
        text = self._extract_text(msg)
        if text is None:
            return
        token = self._token()
        issue = find_issue_by_identifier(token, tenant["company_id"], identifier,
                                         assignee_agent_id=tenant["ceo_agent_id"])
        if not issue:
            self.tg.send_message(chat_id, "Konnte kein passendes Issue ({}) finden.".format(identifier))
            return
        try:
            add_comment(token, issue["id"], text, resume=True)
            self._reply(chat_id, "✅ Antwort an CEO ({}) gesendet.".format(identifier),
                        reply_to_message_id=msg["message_id"])
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            self.tg.send_message(chat_id, "⚠️ Konnte die Antwort nicht senden, bitte erneut.")

    # ---- Chat-Agent (LLM + prompt-gesteuerte Werkzeuge) ----
    def _remember(self, chat_id, user_text, assistant_text):
        hist = self.history.setdefault(chat_id, [])
        hist.append({"role": "user", "content": user_text})
        hist.append({"role": "assistant", "content": assistant_text})
        if len(hist) > MAX_HISTORY_MESSAGES:
            del hist[:len(hist) - MAX_HISTORY_MESSAGES]

    def _handle_chat(self, tenant, msg, text):
        chat_id = msg["chat"]["id"]
        text = (text or "").strip()
        hist = self.history.get(chat_id, [])
        result = jarvis_brain.respond(text, tenant, self._token(),
                                      self._chat_model(), history=hist,
                                      web_key=self.cfg.get("web_key"))
        kind, answer = result["kind"], result["answer"]
        if kind in ("empty", "unparsed_ok", "unparsed_fail"):
            self.tg.send_message(chat_id, answer)
            return
        self._remember(chat_id, text, answer)
        self._reply(chat_id, answer, reply_to_message_id=msg["message_id"])

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
                issues = list_issues(token, tenant["company_id"],
                                     assignee_agent_id=tenant["ceo_agent_id"])
                # Re-Raise-Fall: Label wurde entfernt (Mensch hat entschieden)
                # und später erneut gesetzt -> Key aus 'seen' droppen, damit
                # collect_events das als neues Event erkennt. Streng auf die
                # Issue-IDs DIESES Mandanten skaliert.
                stale = notifier.reconcile_decision_keys(issues, label_id, base_seen)
                tenant_seen = base_seen - stale if stale else base_seen
                if stale:
                    self.seen -= stale
                events, keys = notifier.collect_events(issues, label_id, tenant_seen)
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
                try:
                    self.poll_tenants()
                except Exception:  # noqa: BLE001
                    traceback.print_exc()
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
        "reply_mode_path": config.REPLY_MODE_PATH,
        "eleven_api_key": env.get("ELEVENLABS_API_KEY"),
        "chat_model": env.get("CHAT_MODEL") or llm.DEFAULT_MODEL,
        "web_key": env.get("TAVILY_API_KEY"),
    }
    app = BotApp(Telegram(env["TELEGRAM_BOT_TOKEN"]), cfg)
    loaded = state.load_state(config.STATE_PATH)
    app.seen = loaded if loaded is not None else set()
    app._seeded = loaded is not None
    return app


if __name__ == "__main__":
    print("voice-echo jarvis-bot startet…", file=sys.stderr)
    build_app().run()
