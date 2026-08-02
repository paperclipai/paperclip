import os

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

DEFAULT_SIZE = "1024x1024"
DEFAULT_QUALITY = "medium"
ALLOWED_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
ALLOWED_QUALITIES = {"low", "medium", "high", "auto"}

DAILY_IMAGE_LIMIT = 15
MONTHLY_BUDGET_USD = 4.50   # Puffer unter dem $5/Monat-API-Budget
COST_ESTIMATE = {"low": 0.02, "medium": 0.04, "high": 0.17, "auto": 0.04}

MAIL_WEBHOOK = "http://127.0.0.1:5678/webhook/mailhub/send"
MAIL_FROM = "office@whitestag.ai"
MAIL_TO = "ws@whitestag.ai"

# --- Lokales Rendern ---
ALLOWED_MODELS = {"qwen", "openai"}
DEFAULT_MODEL = "qwen"

ALLOWED_FORMATS = {"1024x1024", "1024x1536", "1536x1024", "1344x768", "768x1344"}
DEFAULT_FORMAT = "1024x1024"

# Formate, die die OpenAI-API nicht kennt, auf das naechstliegende abbilden.
OPENAI_FORMAT_MAP = {"1344x768": "1536x1024", "768x1344": "1024x1536"}

DAILY_LOCAL_LIMIT = 60      # Amoklauf-Bremse, kostet nichts, schuetzt den Knoten
MAX_INFLIGHT_JOBS = 3       # gleichzeitig auf dem Knoten
JOB_TIMEOUT_SEC = 300       # gemessen: 72 s kalt, 8 s warm
UNREACHABLE_ALERT_CYCLES = 30   # 30 Zyklen a 60 s = 30 Minuten

MAX_SEED = 18446744073709551615  # KSampler.seed max from ComfyUI node schema

# --- ComfyUI-Renderknoten (MacBook M5 Max) ---
COMFY_BASE = "http://192.168.2.40:8189"
COMFY_HTTP_TIMEOUT = 30          # Sekunden je HTTP-Aufruf
