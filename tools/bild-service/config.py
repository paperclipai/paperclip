import os
import re

def read_secret(path, key):
    """Read a secret value from a KEY=value file.

    Args:
        path: Path to the secrets file
        key: The key to look for (e.g. "OPENAI_API_KEY")

    Returns:
        The value part, stripped of whitespace

    Raises:
        RuntimeError: If key is not found in file
    """
    try:
        with open(path) as f:
            prefix = key + "="
            for line in f:
                stripped = line.lstrip()
                if stripped.startswith(prefix):
                    return stripped[len(prefix):].strip()
    except FileNotFoundError:
        raise RuntimeError(f"Secrets-File nicht gefunden: {path}")

    raise RuntimeError(f"{key} nicht in Secrets-File gefunden: {path}")

PAPERCLIP_BASE = "http://localhost:3100"
AUTH_JSON = os.path.expanduser("~/.paperclip/auth.json")
SECRETS_ENV = os.path.expanduser("~/.paperclip/instances/default/secrets/openai_image.env")
MAIL_SECRET_ENV = os.path.expanduser("~/.paperclip/instances/default/secrets/mailhub.env")
STATE_FILE = os.path.expanduser("~/.paperclip/instances/default/state/bild-service.json")

COMPANIES = [
    {"name": "WHITESTAG", "id": "9cebf3cf-efe8-4597-a400-f06488900a87", "label": "9433325a-fa6e-43c2-bb09-b077a01843de"},
    {"name": "Clara",     "id": "0e426844-309c-4528-9aa5-90ff76790a51", "label": "f8212203-db94-4c20-9922-0078289e874e"},
    {"name": "Health",    "id": "158c4959-4973-4cb0-8066-55ec0f35625e", "label": "36ad26e6-4ed8-4ac3-8f43-28c8600a1ab1"},
]

POLL_STATUSES = ["todo", "backlog"]

DEFAULT_QUALITY = "medium"
ALLOWED_QUALITIES = {"low", "medium", "high", "auto"}

DAILY_IMAGE_LIMIT = 15
MONTHLY_BUDGET_USD = 4.50   # Puffer unter dem $5/Monat-API-Budget
COST_ESTIMATE = {"low": 0.02, "medium": 0.04, "high": 0.17, "auto": 0.04}

MAIL_WEBHOOK = "http://127.0.0.1:5678/webhook/mailhub/send"
MAIL_FROM = "office@whitestag.ai"
MAIL_TO = "ws@whitestag.ai"

# --- Lokales Rendern ---
ALLOWED_MODELS = {"qwen", "qwen360", "qwenedit", "openai"}
DEFAULT_MODEL = "qwen"

# Lokales Modell -> Workflow-Vorlage in workflows/<name>.api.json. Der Name
# darf NICHT mehr im Code stehen: sonst rendert jeder neue Modellname still
# das Standardbild.
LOCAL_WORKFLOWS = {
    "qwen": "qwen-image",
    "qwen360": "qwen-360",
    "qwenedit": "qwen-edit",
}

# Modelle, die ein oder mehrere Quellbilder brauchen. Ohne Anhang ist der
# Auftrag nicht ausfuehrbar -- das ist kein Standardfall, sondern ein Abbruch.
EDIT_MODELS = {"qwenedit"}
MAX_SOURCE_IMAGES = 3
MAX_SOURCE_BYTES = 20 * 1024 * 1024


def output_filename(issue_id):
    """Dateiname, unter dem der Dienst sein eigenes Ergebnis hochlaedt.

    Erzeuger (der upload_attachment-Aufruf in bild_service.py) UND Filter
    (sources.OUTPUT_FILENAME_RE / pick_source_images) bilden den Namen ueber
    DIESE Funktion -- sonst koennten sie unbemerkt auseinanderlaufen und ein
    wiedereingereihtes Issue wuerde sein eigenes Ergebnis wieder als
    Quellbild lesen (Befund 1).
    """
    return "bild-%s.png" % issue_id[:8]


# Erkennt einen vom Dienst selbst erzeugten Ausgabeanhang am Dateinamen.
# createdByAgentId taugt NICHT als Kennzeichen: der Dienst laedt ueber das
# Board-Token als User hoch (assets.created_by_agent_id bleibt bei eigenen
# Uploads leer, an echten Datensaetzen geprueft) -- einzig verlaessliches
# Merkmal ist der Dateiname.
OUTPUT_FILENAME_RE = re.compile(r"^bild-[0-9a-f]{8}\.png$", re.IGNORECASE)

ALLOWED_FORMATS = {"1024x1024", "1024x1536", "1536x1024", "1344x768", "768x1344"}
DEFAULT_FORMAT = "1024x1024"

# Modelle mit eigenem Formatzwang. 360-Panoramen brauchen 2:1 -- bei anderen
# Seitenverhaeltnissen verfehlt das Modell laut Modellkarte den Horizont, und
# 2048x1024 ist die einzige Aufloesung, fuer die es trainiert wurde.
MODEL_FORMATS = {
    "qwen360": {"allowed": {"2048x1024", "1536x768", "1024x512"},
                "default": "2048x1024"},
}

# Formate, die die OpenAI-API nicht kennt, auf das naechstliegende abbilden.
OPENAI_FORMAT_MAP = {"1344x768": "1536x1024", "768x1344": "1024x1536",
                     "2048x1024": "1536x1024", "1536x768": "1536x1024",
                     "1024x512": "1536x1024"}

DAILY_LOCAL_LIMIT = 60      # Amoklauf-Bremse, kostet nichts, schuetzt den Knoten
MAX_INFLIGHT_JOBS = 3       # gleichzeitig auf dem Knoten
JOB_TIMEOUT_SEC = 300       # gemessen auf dem Headless-Knoten: 14,1 s warm, 35 s nach Neustart

# Modelle, die laenger brauchen als der Standarddeckel. 360 laeuft mit 20
# Schritten auf 2048x1024 (~11 s je Schritt gemessen) und wuerde von den 300 s
# mitten im Lauf abgeraeumt und sinnlos neu eingereiht.
MODEL_JOB_TIMEOUT_SEC = {"qwen360": 900, "qwenedit": 600}

UNREACHABLE_ALERT_CYCLES = 30   # 30 Zyklen a 60 s = 30 Minuten

# Dasselbe fuer Paperclip selbst (:3100). Eigener Wert, weil es ein anderer
# Ausfall ist: faellt der Renderknoten aus, laeuft der Dienst weiter und
# sammelt nur nichts ein -- faellt :3100 aus, geht GAR NICHTS mehr, und jeder
# Zyklus scheitert sofort. Vorfall 21.08.: :3100 lag im Crashloop, und der
# Dienst mailte ungedaempft im Minutentakt "Zyklus abgebrochen".
# :3100 laeuft als Dev-Server unter launchd und ist bei jedem Neustart ein
# paar Minuten weg -- die Schwelle muss deutlich darueber liegen.
PAPERCLIP_UNREACHABLE_ALERT_CYCLES = 30   # 30 Zyklen a 60 s = 30 Minuten

# Befund 2 + 3: Absende- bzw. Hochladeversuche, die je Issue hintereinander
# scheitern, OBWOHL der Knoten/Paperclip grundsaetzlich reagiert (kein
# 'unreachable' im Sinne von UNREACHABLE_ALERT_CYCLES). Absichtlich deutlich
# kleiner als UNREACHABLE_ALERT_CYCLES: eine kurze Netzwerkstoerung ist dort
# schon abgedeckt (Auftrag bleibt bewusst UNBEGRENZT liegen, siehe
# note_unreachable) -- hier geht es um einen Fehler, der sich durch Warten
# nicht von selbst loest (z.B. eine umbenannte Modelldatei oder ein
# geloeschtes Asset). 10 Zyklen a 60 s = 10 Minuten toleriert ein paar
# Ausrutscher, ohne bis zu drei Quellbilder ueber eine halbe Stunde lang
# jeden Zyklus sinnlos neu hoch- und wieder zu verwerfen.
FAILED_SUBMIT_CANCEL_CYCLES = 10

# Absoluter Notausstieg: Jobs, deren "done"-Verarbeitung wiederholt an einer
# Exception scheitert (z.B. Issue geloescht, Ausgabedatei weg), wuerden sonst
# fuer immer einen der drei Inflight-Plaetze blockieren. Vielfaches von
# JOB_TIMEOUT_SEC, ab dem ein Job zwangsweise abgebrochen wird, egal was der
# Knoten meldet.
STUCK_JOB_AGE_MULTIPLIER = 10

MAX_SEED = 18446744073709551615  # KSampler.seed max from ComfyUI node schema

# --- ComfyUI-Renderknoten (MacBook M5 Max) ---
COMFY_BASE = "http://192.168.2.40:8189"
COMFY_HTTP_TIMEOUT = 30          # Sekunden je HTTP-Aufruf
