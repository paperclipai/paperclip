import os

PAPERCLIP_BASE = "http://localhost:3100"
AUTH_JSON = os.path.expanduser("~/.paperclip/auth.json")
SECRETS_ENV = os.path.expanduser("~/.paperclip/instances/default/secrets/openai_image.env")
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
MAIL_SECRET = "mailhub-812a27b07c73e64d7df192c98a3883eb"
MAIL_FROM = "office@whitestag.ai"
MAIL_TO = "ws@whitestag.ai"
