# tools/voice-echo-bot/jarvis_brain.py
"""Jarvis' Antwort-Gehirn — geteilt zwischen Telegram-Bot und Wake-Satellit.

Reine Logik: Text rein, {"kind","answer"} raus. Kein Telegram, kein Mikrofon.
Kapselt System-Prompt, Steuer-Token-Parsing (LOOKUP/ISSUE/WEB) und die
Werkzeug-Ausführung (Vault-Lookup, CEO-Issue, Websuche, Unausgewertet-
Notfall). Nach einem Vault-Lookup wird in derselben Anfrage kein weiteres
Werkzeug mehr ausgeführt (Datenschutz-Sperre). stdlib only.
"""
import datetime
import json
import re
import traceback

import llm
import vault_client
import web_search
from paperclip_client import create_issue, derive_title

# Kopfteil des System-Prompts: Einleitung + Werkzeuge 1 (Vault) und 2 (Issue).
# Wird in respond() um WEB_TOOL_HINT (Werkzeug 3, nur mit web_key) und danach
# um SYSTEM_PROMPT_TAIL ergänzt — siehe dort für die Zusammensetzung.
SYSTEM_PROMPT_HEAD = (
    "Du bist Jarvis, der persönliche CEO-Draht von {name}. Du bist ein ganz "
    "normaler Chat-Assistent: antworte knapp, auf Deutsch, sprich {name} mit "
    "Vornamen an, keine Meta-Sätze (\"Als KI …\"), keine Floskeln.\n\n"
    "Du hast diese Werkzeuge. Brauchst du eines, gib in der ERSTEN Zeile GENAU "
    "EIN Steuer-Token aus (nichts davor, keine Anführungszeichen):\n\n"
    "1. Vault nachschlagen — für echte Daten (Telefonnummer, Adresse, E-Mail "
    "einer Person; Termine; frühere Mails; Wissens-/Business-Fragen):\n"
    "   LOOKUP <modus>: <suchbegriff>\n"
    "   modus = kontakt (Tel/Mail/Adresse einer Person) | termin (Kalender) | "
    "mail (frühere E-Mails) | wissen (Wissens-/Business-Fragen) | dokument (Volltextsuche in ALLEN Dokumenten/Unterlagen des Vaults, z.B. Angebote, Verträge, Projekte).\n"
    "   Beispiel: LOOKUP kontakt: Jana Kostbar\n\n"
    "2. Aufgabe beim CEO anlegen — NUR wenn {name} dich ausdrücklich darum "
    "bittet (\"leg an\", \"erstelle einen Task\", \"kümmer dich um\"):\n"
    "   ISSUE: <titel> :: <beschreibung>\n"
    "   Beispiel: ISSUE: DMARC einrichten :: DMARC für whitestag.ai konfigurieren."
)

# Schlussteil: folgt in respond() auf den Kopfteil bzw. (falls vorhanden) auf
# WEB_TOOL_HINT — trägt daher die trennende Leerzeile selbst am Anfang.
SYSTEM_PROMPT_TAIL = (
    "\n\nBrauchst du KEIN Werkzeug, antworte einfach direkt als Chat-Text (kein "
    "Token). Frag nicht um Erlaubnis, ein Werkzeug zu nutzen — nutze es einfach."
)

# Wochentage/Monate fest im Code: unter launchd ist die Locale typischerweise
# "C", dann lieferte strftime("%A") englische Namen.
WEEKDAYS = ("Montag", "Dienstag", "Mittwoch", "Donnerstag",
            "Freitag", "Samstag", "Sonntag")
MONTHS = ("Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
          "August", "September", "Oktober", "November", "Dezember")

TIME_HINT = ("\n\nAktuelle Zeit: {}. Nutze sie direkt für Fragen nach Uhrzeit, "
             "Datum oder Wochentag — dafür brauchst du kein Werkzeug.")


def format_now(now):
    """Datum/Uhrzeit als deutscher Klartext für den System-Prompt."""
    return "{}, {}. {} {}, {:02d}:{:02d} Uhr".format(
        WEEKDAYS[now.weekday()], now.day, MONTHS[now.month - 1],
        now.year, now.hour, now.minute)


LOOKUP_RE = re.compile(r"^\s*LOOKUP\s+(kontakt|termin|mail|wissen|dokument)\s*:\s*(.+)$",
                       re.IGNORECASE)
ISSUE_RE = re.compile(r"^\s*ISSUE\s*:\s*(.+)$", re.IGNORECASE)
WEB_RE = re.compile(r"^\s*WEB\s*:\s*(.+)$", re.IGNORECASE)


def first_name(tenant):
    name = (tenant.get("name") or "").strip()
    head = name.split("/")[0].strip()
    return head.split()[0] if head else "Chef"


def parse_control(raw):
    text = (raw or "").strip()
    lines = text.splitlines()
    first = lines[0] if lines else ""
    m = LOOKUP_RE.match(first)
    if m:
        return {"kind": "lookup", "mode": m.group(1).lower(),
                "query": m.group(2).strip()}
    m = ISSUE_RE.match(first)
    if m:
        title, sep, desc = m.group(1).partition("::")
        title = title.strip()
        desc = desc.strip() if sep else ""
        return {"kind": "issue", "title": title, "description": desc or title}
    m = WEB_RE.match(first)
    if m:
        return {"kind": "web", "query": m.group(1).strip()}
    return {"kind": "chat", "text": text}


VOICE_OUTPUT_HINT = (
    "\n\nWICHTIG — Sprachausgabe: Deine Antwort wird laut vorgelesen. Schreibe "
    "deshalb ALLE Zahlen, Uhrzeiten, Datumsangaben und Jahre als ausgeschriebene "
    "deutsche Wörter, NIEMALS als Ziffern. Beispiele: „12:30\" -> „zwölf Uhr "
    "dreißig\"; „2026\" -> „zweitausendsechsundzwanzig\"; „26.07.\" -> "
    "„sechsundzwanzigster Juli\"; „15 °C\" -> „fünfzehn Grad\"; „5 €\" -> „fünf "
    "Euro\". Lange Ziffernfolgen (Telefon, IBAN) in kleinen Gruppen ausschreiben "
    "(z. B. „030 12 34\" -> „null drei null, zwölf, vierunddreißig\")."
)

WEB_TOOL_HINT = (
    "\n\n3. Web durchsuchen — für alles, was du nicht wissen kannst, weil es "
    "aktuell oder öffentlich ist (Wetter, Nachrichten, Verkehr, Öffnungszeiten, "
    "Preise, Fakten von Webseiten):\n"
    "   WEB: <suchbegriff>\n"
    "   Beispiel: WEB: Wetter Cottbus morgen\n"
    "   Rate NIE bei solchen Fragen — such nach oder sag, dass du es nicht weißt."
)


def _strip_control_lines(text):
    """Entfernt versehentlich eingestreute Steuer-Token-Zeilen (LOOKUP/ISSUE/
    WEB) aus einer Chat-Antwort. Manche Modelle hängen so ein Token ans Ende,
    obwohl sie direkt geantwortet haben — ungefiltert würde es laut vorgelesen."""
    kept = [ln for ln in (text or "").splitlines()
            if not LOOKUP_RE.match(ln) and not ISSUE_RE.match(ln)
            and not WEB_RE.match(ln)]
    return "\n".join(kept).strip()


# Fester Ersatztext, falls nach dem Strippen nichts übrig bleibt: hält sich
# das Modell im Folge-Durchgang NICHT an "Gib KEIN Steuer-Token mehr aus" und
# besteht seine Antwort NUR aus einem (weiteren) Steuer-Token, würde
# _strip_control_lines() einen Leerstring liefern. Bei der Sprachausgabe
# heisst leerer Text: Jarvis schweigt — das schlechteste aller Verhalten,
# also nie ungeprüft zurückgeben.
EMPTY_TOOL_ANSWER = "⚠️ Habe dazu keine verwertbare Antwort bekommen, bitte gleich nochmal fragen."


def _strip_or_fallback(text):
    """Wie `_strip_control_lines`, garantiert aber nie einen Leerstring —
    siehe `EMPTY_TOOL_ANSWER`."""
    return _strip_control_lines(text) or EMPTY_TOOL_ANSWER


def respond(text, tenant, token, chat_model, history=None, source="per Telegram",
            voice_output=False, now=None, web_key=None):
    text = (text or "").strip()
    if not text:
        return {"kind": "empty", "answer": "Nichts erkannt, bitte erneut."}
    hist = history or []
    # Reihenfolge ist bewusst: WEB_TOOL_HINT (Werkzeug 3) muss VOR dem
    # "Brauchst du KEIN Werkzeug"-Absatz stehen, sonst liest ein kleines
    # Modell es nicht mehr als Teil der Werkzeugliste (Review-Befund).
    system_content = SYSTEM_PROMPT_HEAD.format(name=first_name(tenant))
    if web_key:
        system_content += WEB_TOOL_HINT
    system_content += SYSTEM_PROMPT_TAIL
    system_content += TIME_HINT.format(format_now(now or datetime.datetime.now()))
    if voice_output:
        system_content += VOICE_OUTPUT_HINT
    messages = ([{"role": "system", "content": system_content}]
                + list(hist) + [{"role": "user", "content": text}])
    try:
        raw = llm.chat(messages, model=chat_model)
    except llm.LlmError:
        traceback.print_exc()
        return _unparsed(text, tenant, token, source)
    action = parse_control(raw)
    if action["kind"] == "lookup":
        return {"kind": "lookup",
                "answer": _do_lookup(messages, action["mode"], action["query"], tenant, chat_model)}
    if action["kind"] == "issue":
        return {"kind": "issue",
                "answer": _do_issue(action["title"], action["description"], tenant, token)}
    if action["kind"] == "web":
        if not web_key:
            # Ohne Key ist das Werkzeug nicht im Prompt — kommt trotzdem eines
            # durch, muss die Antwort ehrlich sein und darf nicht leer werden
            # (leerer Text = stumme Sprachausgabe).
            return {"kind": "chat",
                    "answer": "Dafür müsste ich ins Netz — das ist gerade nicht eingerichtet."}
        return {"kind": "web",
                "answer": _do_web(messages, action["query"], chat_model, web_key)}
    return {"kind": "chat", "answer": _strip_control_lines(action["text"])}


def _do_lookup(messages, mode, query, tenant, chat_model):
    try:
        result = vault_client.lookup(mode, query, vault=tenant.get("vault"))
    except vault_client.VaultError:
        traceback.print_exc()
        result = {"mode": mode, "query": query, "treffer": [],
                  "fehler": "Vault-Dienst nicht erreichbar"}
    if result.get("vault_unknown"):
        return ("⚠️ Ich kann darauf nicht zugreifen — der für diesen Chat "
                "hinterlegte Vault ist unbekannt oder falsch konfiguriert. "
                "Bitte an die Administration wenden.")
    context = json.dumps(result, ensure_ascii=False)[:4000]
    followup = messages + [
        {"role": "assistant", "content": "LOOKUP {}: {}".format(mode, query)},
        {"role": "user", "content":
            ("Vault-Treffer (JSON):\n{}\n\nBeantworte meine letzte Frage knapp auf "
             "Deutsch mit diesen Daten. Ist nichts Passendes dabei, sag das ehrlich. "
             "Gib KEIN Steuer-Token mehr aus.").format(context)},
    ]
    try:
        answer = llm.chat(followup, model=chat_model)
    except llm.LlmError:
        traceback.print_exc()
        return "⚠️ Konnte die Vault-Daten nicht auswerten, bitte gleich nochmal."
    # Nach einem Vault-Zugriff wird KEIN weiteres Werkzeug mehr ausgeführt:
    # in dieser Anfrage gewonnene Vault-Daten dürfen nicht nach draussen
    # (z.B. in einen Suchbegriff) wandern. Token werden nur entfernt.
    return _strip_or_fallback(answer)


def _do_web(messages, query, chat_model, api_key):
    print("[web] query='{}'".format((query or "").replace("\n", " ")[:120]),
          flush=True)
    # Kürzere Timeouts als beim Vault-Lookup: der Nutzer wartet im Sprachpfad
    # nach dem Bestätigungston stumm, Tavily (extern, langsamer als der Vault)
    # und der Folge-LLM-Durchgang sollen dafür nicht die vollen Defaults
    # (15s/90s) ausreizen (Review-Befund).
    try:
        result = web_search.search(query, api_key, timeout=8)
    except web_search.WebSearchError:
        traceback.print_exc()
        return "⚠️ Ich komme gerade nicht ins Netz."
    context = json.dumps(result, ensure_ascii=False)[:4000]
    followup = messages + [
        {"role": "assistant", "content": "WEB: {}".format(query)},
        {"role": "user", "content":
            ("Web-Suchergebnis (JSON):\n{}\n\nBeantworte meine letzte Frage knapp "
             "auf Deutsch mit diesen Daten. Ist nichts Passendes dabei, sag das "
             "ehrlich. Nenne keine URLs. Gib KEIN Steuer-Token mehr aus."
             ).format(context)},
    ]
    try:
        answer = llm.chat(followup, model=chat_model, timeout=30)
    except llm.LlmError:
        traceback.print_exc()
        return "⚠️ Konnte das Suchergebnis nicht auswerten, bitte gleich nochmal."
    return _strip_or_fallback(answer)


def _do_issue(title, description, tenant, token):
    try:
        issue = create_issue(token, tenant["company_id"], tenant["ceo_agent_id"],
                             derive_title(title), description)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return "⚠️ Konnte die Aufgabe nicht anlegen, bitte gleich nochmal."
    label = issue.get("identifier") or issue.get("id", "?")
    return "✅ Task angelegt: {}".format(label)


def _unparsed(text, tenant, token, source="per Telegram"):
    description = (
        "Von Walter {source} diktiert. Das Sprachmodell war nicht "
        "erreichbar, der Text ist daher UNAUSGEWERTET durchgereicht — "
        "bitte selbst interpretieren und, falls es keine Aufgabe ist, "
        "schliessen.\n\nWortlaut:\n{text}".format(source=source, text=text)
    )
    try:
        issue = create_issue(token, tenant["company_id"], tenant["ceo_agent_id"],
                             derive_title(text), description)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return {"kind": "unparsed_fail",
                "answer": ("⚠️ Mein Sprachmodell ist nicht erreichbar und ich konnte auch keine "
                           "Aufgabe anlegen — dein Auftrag ist NICHT angekommen. Bitte nochmal senden.")}
    label = issue.get("identifier") or issue.get("id", "?")
    return {"kind": "unparsed_ok",
            "answer": ("⚠️ Mein Sprachmodell ist gerade nicht erreichbar — ich habe deinen Auftrag "
                       "unausgewertet an den CEO weitergegeben: {}".format(label))}
