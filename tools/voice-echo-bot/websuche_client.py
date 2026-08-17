# tools/voice-echo-bot/websuche_client.py
"""Client fuer den lokalen Websuche-Dienst (stdlib urllib).

POST http://127.0.0.1:7789/suche mit {"frage", "quellen", "zeichen", "deadline"}
  -> {"query", "quellen":[{"domain","titel","text","abgerufen_am"}]}

Der Dienst (tools/websuche/) sucht ueber SearXNG, ruft die Treffer ab und gibt
Fliesstext mit Domain und Abrufdatum zurueck. Kein API-Key, keine Suchanfrage
verlaesst das Haus.

URLs werden verworfen — vorgelesene Links sind nutzlos und kosten nur Kontext.
Die **Domain** bleibt erhalten, denn sie ist sprechbar ("laut tagesschau.de")
und ist der Grund, warum dieser Dienst dem Tavily-Weg ueberlegen ist.

Bei Nicht-Erreichbarkeit, 503 (alle Engines blockiert) oder leerem Ergebnis
wird `WebsucheError` geworfen; das Gehirn faellt dann auf Tavily zurueck.

Hinweis: laeuft im Satelliten-venv unter Python 3.9 — keine `X | None`-Syntax.
"""
import json
import re
import urllib.error
import urllib.request

# Die Textextraktion des Diensts laesst URLs im Fliesstext stehen
# ("WetterOnline ( https://www.wetteronline.de ) meldet ..."). Vorgelesen sind
# sie unbrauchbar, deshalb fliegen sie hier raus — die Domain als
# Quellenangabe steht ohnehin in einem eigenen Feld.
_URL_MUSTER = re.compile(r"(https?://\S+|\bwww\.\S+)")

DIENST_URL = "http://127.0.0.1:7789/suche"
# Zwei Quellen a 1500 Zeichen statt der Dienst-Defaults (3 a 12000): die
# Nutzlast bleibt bei ~3-4 KB und passt damit in das Kontextbudget des
# Folge-Prompts, statt mitten in der ersten Quelle abgeschnitten zu werden.
DEFAULT_QUELLEN = 2
# Etwas mehr als das Kontextbudget des Gehirns (WEB_CONTEXT_ZEICHEN), damit
# dort noch etwas zu kappen ist — aber nicht das Vielfache: Text, den niemand
# liest, kostet nur Abrufzeit.
DEFAULT_ZEICHEN = 800
# Der Dienst soll selbst aufgeben, bevor der Client das Warten abbricht —
# sonst laeuft dort eine Suche weiter, deren Ergebnis niemand mehr abholt.
DEFAULT_DEADLINE = 7.0
DEFAULT_TIMEOUT = 8


class WebsucheError(Exception):
    """Dienst nicht erreichbar, blockiert oder Antwort unbrauchbar."""


def _ohne_urls(text):
    """Entfernt URLs aus dem Fliesstext und raeumt die Luecken auf."""
    ohne = _URL_MUSTER.sub(" ", text)
    # Leere Klammerreste ("( )") und Mehrfach-Leerzeichen aufraeumen, damit
    # der Satz vorlesbar bleibt.
    ohne = re.sub(r"\(\s*\)", " ", ohne)
    return re.sub(r"[ \t]{2,}", " ", ohne).strip()


def suche(query, quellen=DEFAULT_QUELLEN, zeichen=DEFAULT_ZEICHEN,
          deadline=DEFAULT_DEADLINE, url=DIENST_URL, timeout=DEFAULT_TIMEOUT):
    """Fragt den lokalen Dienst und gibt ein normalisiertes dict zurueck."""
    body = json.dumps({
        "frage": query,
        "quellen": quellen,
        "zeichen": zeichen,
        "deadline": deadline,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise WebsucheError("Websuche HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise WebsucheError("Websuche nicht erreichbar: {}".format(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise WebsucheError("Websuche-Antwort nicht lesbar: {}".format(exc)) from exc
    if not isinstance(data, dict):
        raise WebsucheError("Websuche-Antwort hat unerwartetes Format")
    gefunden = []
    for item in data.get("quellen") or []:
        if not isinstance(item, dict):
            continue
        text = _ohne_urls(item.get("text") or "")
        if not text:
            # Quelle ohne Fliesstext (robots.txt verbietet, Binaerinhalt) oder
            # eine, die nach dem Entfernen der URLs leer ist: traegt nichts bei
            # und kostet nur Kontext.
            continue
        gefunden.append({"domain": item.get("domain") or "",
                         "titel": item.get("titel") or "",
                         "text": text,
                         "abgerufen_am": item.get("abgerufen_am") or ""})
    if not gefunden:
        # Der Dienst hat geantwortet, aber nichts gelesen. Als Erfolg
        # durchgereicht wuerde das den Tavily-Fallback verhindern und dem
        # Modell eine Antwort ohne Grundlage abverlangen.
        raise WebsucheError("Websuche lieferte keine brauchbare Quelle")
    return {"query": query, "quellen": gefunden}
