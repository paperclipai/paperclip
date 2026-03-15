"""Environment and API key management for last30days skill."""

import base64
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Dict, Any, Literal

# Allow override via environment variable for testing
# Set LAST30DAYS_CONFIG_DIR="" for clean/no-config mode
# Set LAST30DAYS_CONFIG_DIR="/path/to/dir" for custom config location
_config_override = os.environ.get('LAST30DAYS_CONFIG_DIR')
if _config_override == "":
    # Empty string = no config file (clean mode)
    CONFIG_DIR = None
    CONFIG_FILE = None
elif _config_override:
    CONFIG_DIR = Path(_config_override)
    CONFIG_FILE = CONFIG_DIR / ".env"
else:
    CONFIG_DIR = Path.home() / ".config" / "last30days"
    CONFIG_FILE = CONFIG_DIR / ".env"

CODEX_AUTH_FILE = Path(os.environ.get("CODEX_AUTH_FILE", str(Path.home() / ".codex" / "auth.json")))

AuthSource = Literal["api_key", "codex", "none"]
AuthStatus = Literal["ok", "missing", "expired", "missing_account_id"]

AUTH_SOURCE_API_KEY: AuthSource = "api_key"
AUTH_SOURCE_CODEX: AuthSource = "codex"
AUTH_SOURCE_NONE: AuthSource = "none"

AUTH_STATUS_OK: AuthStatus = "ok"
AUTH_STATUS_MISSING: AuthStatus = "missing"
AUTH_STATUS_EXPIRED: AuthStatus = "expired"
AUTH_STATUS_MISSING_ACCOUNT_ID: AuthStatus = "missing_account_id"


@dataclass(frozen=True)
class OpenAIAuth:
    token: Optional[str]
    source: AuthSource
    status: AuthStatus
    account_id: Optional[str]
    codex_auth_file: str


def _check_file_permissions(path: Path) -> None:
    """Warn to stderr if a secrets file has overly permissive permissions."""
    try:
        mode = path.stat().st_mode
        # Check if group or other can read (bits 0o044)
        if mode & 0o044:
            import sys
            sys.stderr.write(
                f"[last30days] WARNING: {path} is readable by other users. "
                f"Run: chmod 600 {path}\n"
            )
            sys.stderr.flush()
    except OSError:
        pass


def load_env_file(path: Path) -> Dict[str, str]:
    """Load environment variables from a file."""
    env = {}
    if not path or not path.exists():
        return env
    _check_file_permissions(path)

    with open(path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip()
                # Remove quotes if present
                if value and value[0] in ('"', "'") and value[-1] == value[0]:
                    value = value[1:-1]
                if key and value:
                    env[key] = value
    return env


def _decode_jwt_payload(token: str) -> Optional[Dict[str, Any]]:
    """Decode JWT payload without verification."""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload_b64 = parts[1]
        pad = "=" * (-len(payload_b64) % 4)
        decoded = base64.urlsafe_b64decode(payload_b64 + pad)
        return json.loads(decoded.decode("utf-8"))
    except Exception:
        return None


def _token_expired(token: str, leeway_seconds: int = 60) -> bool:
    """Check if JWT token is expired."""
    payload = _decode_jwt_payload(token)
    if not payload:
        return False
    exp = payload.get("exp")
    if not exp:
        return False
    return exp <= (time.time() + leeway_seconds)


def extract_chatgpt_account_id(access_token: str) -> Optional[str]:
    """Extract chatgpt_account_id from JWT token."""
    payload = _decode_jwt_payload(access_token)
    if not payload:
        return None
    auth_claim = payload.get("https://api.openai.com/auth", {})
    if isinstance(auth_claim, dict):
        return auth_claim.get("chatgpt_account_id")
    return None


def load_codex_auth(path: Path = CODEX_AUTH_FILE) -> Dict[str, Any]:
    """Load Codex auth JSON."""
    if not path.exists():
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def get_codex_access_token() -> tuple[Optional[str], str]:
    """Get Codex access token from auth.json.

    Returns:
        (token, status) where status is 'ok', 'missing', or 'expired'
    """
    auth = load_codex_auth()
    token = None
    if isinstance(auth, dict):
        tokens = auth.get("tokens") or {}
        if isinstance(tokens, dict):
            token = tokens.get("access_token")
        if not token:
            token = auth.get("access_token")
    if not token:
        return None, AUTH_STATUS_MISSING
    if _token_expired(token):
        return None, AUTH_STATUS_EXPIRED
    return token, AUTH_STATUS_OK


def get_openai_auth(file_env: Dict[str, str]) -> OpenAIAuth:
    """Resolve OpenAI auth from API key or Codex login."""
    api_key = os.environ.get('OPENAI_API_KEY') or file_env.get('OPENAI_API_KEY')
    if api_key:
        return OpenAIAuth(
            token=api_key,
            source=AUTH_SOURCE_API_KEY,
            status=AUTH_STATUS_OK,
            account_id=None,
            codex_auth_file=str(CODEX_AUTH_FILE),
        )

    codex_token, codex_status = get_codex_access_token()
    if codex_token:
        account_id = extract_chatgpt_account_id(codex_token)
        if account_id:
            return OpenAIAuth(
                token=codex_token,
                source=AUTH_SOURCE_CODEX,
                status=AUTH_STATUS_OK,
                account_id=account_id,
                codex_auth_file=str(CODEX_AUTH_FILE),
            )
        return OpenAIAuth(
            token=None,
            source=AUTH_SOURCE_CODEX,
            status=AUTH_STATUS_MISSING_ACCOUNT_ID,
            account_id=None,
            codex_auth_file=str(CODEX_AUTH_FILE),
        )

    return OpenAIAuth(
        token=None,
        source=AUTH_SOURCE_NONE,
        status=codex_status,
        account_id=None,
        codex_auth_file=str(CODEX_AUTH_FILE),
    )


def _find_project_env() -> Optional[Path]:
    """Find per-project .env by walking up from cwd.

    Searches for .claude/last30days.env in each parent directory,
    stopping at the user's home directory or filesystem root.
    """
    cwd = Path.cwd()
    for parent in [cwd, *cwd.parents]:
        candidate = parent / '.claude' / 'last30days.env'
        if candidate.exists():
            return candidate
        # Stop at filesystem root or home
        if parent == Path.home() or parent == parent.parent:
            break
    return None


def get_config() -> Dict[str, Any]:
    """Load configuration from multiple sources.

    Priority (highest wins):
      1. Environment variables (os.environ)
      2. .claude/last30days.env (per-project config)
      3. ~/.config/last30days/.env (global config)
    """
    # Load from global config file
    file_env = load_env_file(CONFIG_FILE) if CONFIG_FILE else {}

    # Load from per-project config (overrides global)
    project_env_path = _find_project_env()
    project_env = load_env_file(project_env_path) if project_env_path else {}

    # Merge: project overrides global
    merged_env = {**file_env, **project_env}

    openai_auth = get_openai_auth(merged_env)

    # Build config: Codex/OpenAI auth + process.env > project .env > global .env
    config = {
        'OPENAI_API_KEY': openai_auth.token,
        'OPENAI_AUTH_SOURCE': openai_auth.source,
        'OPENAI_AUTH_STATUS': openai_auth.status,
        'OPENAI_CHATGPT_ACCOUNT_ID': openai_auth.account_id,
        'CODEX_AUTH_FILE': openai_auth.codex_auth_file,
    }

    keys = [
        ('XAI_API_KEY', None),
        ('OPENROUTER_API_KEY', None),
        ('PARALLEL_API_KEY', None),
        ('BRAVE_API_KEY', None),
        ('XIAOHONGSHU_API_BASE', None),
        ('OPENAI_MODEL_POLICY', 'auto'),
        ('OPENAI_MODEL_PIN', None),
        ('XAI_MODEL_POLICY', 'latest'),
        ('XAI_MODEL_PIN', None),
        ('SCRAPECREATORS_API_KEY', None),
        ('APIFY_API_TOKEN', None),
        ('AUTH_TOKEN', None),
        ('CT0', None),
        ('BSKY_HANDLE', None),
        ('BSKY_APP_PASSWORD', None),
        ('TRUTHSOCIAL_TOKEN', None),
    ]

    for key, default in keys:
        config[key] = os.environ.get(key) or merged_env.get(key, default)

    # Track which config source was used
    if project_env_path:
        config['_CONFIG_SOURCE'] = f'project:{project_env_path}'
    elif CONFIG_FILE and CONFIG_FILE.exists():
        config['_CONFIG_SOURCE'] = f'global:{CONFIG_FILE}'
    else:
        config['_CONFIG_SOURCE'] = 'env_only'

    return config


def config_exists() -> bool:
    """Check if any configuration source exists."""
    if _find_project_env():
        return True
    if CONFIG_FILE:
        return CONFIG_FILE.exists()
    return False


def is_reddit_available(config: Dict[str, Any]) -> bool:
    """Check if Reddit search is available.

    Reddit can use either ScrapeCreators (preferred) or OpenAI.
    """
    has_sc = bool(config.get('SCRAPECREATORS_API_KEY'))
    has_openai = bool(config.get('OPENAI_API_KEY')) and config.get('OPENAI_AUTH_STATUS') == AUTH_STATUS_OK
    return has_sc or has_openai


def get_reddit_source(config: Dict[str, Any]) -> Optional[str]:
    """Determine which Reddit backend to use.

    Priority: ScrapeCreators (cheaper, faster) > OpenAI (legacy)

    Returns: 'scrapecreators', 'openai', or None
    """
    if config.get('SCRAPECREATORS_API_KEY'):
        return 'scrapecreators'
    if config.get('OPENAI_API_KEY') and config.get('OPENAI_AUTH_STATUS') == AUTH_STATUS_OK:
        return 'openai'
    return None


def get_available_sources(config: Dict[str, Any]) -> str:
    """Determine which sources are available.

    Returns: 'all', 'both', 'reddit', 'reddit-web', 'x', 'x-web', 'web', or 'none'
    """
    # Reddit is available via public JSON fallback even without OpenAI auth.
    has_reddit = True
    has_xai = bool(config.get('XAI_API_KEY'))
    has_web = has_web_search_keys(config)

    if has_reddit and has_xai:
        return 'all' if has_web else 'both'
    elif has_reddit:
        return 'reddit-web' if has_web else 'reddit'
    return 'web' if has_web else 'none'


def has_web_search_keys(config: Dict[str, Any]) -> bool:
    """Check if any web search API keys are configured."""
    return bool(config.get('OPENROUTER_API_KEY') or config.get('PARALLEL_API_KEY') or config.get('BRAVE_API_KEY'))


def get_web_search_source(config: Dict[str, Any]) -> Optional[str]:
    """Determine the best available web search backend.

    Priority: Parallel AI > Brave > OpenRouter/Sonar Pro

    Returns: 'parallel', 'brave', 'openrouter', or None
    """
    if config.get('PARALLEL_API_KEY'):
        return 'parallel'
    if config.get('BRAVE_API_KEY'):
        return 'brave'
    if config.get('OPENROUTER_API_KEY'):
        return 'openrouter'
    return None


def get_missing_keys(config: Dict[str, Any]) -> str:
    """Determine which sources are missing (accounting for Bird and ScrapeCreators).

    Returns: 'all', 'both', 'reddit', 'x', 'web', or 'none'
    """
    has_reddit = True
    has_xai = bool(config.get('XAI_API_KEY'))
    has_web = has_web_search_keys(config)

    # Check if Bird provides X access (import here to avoid circular dependency)
    from . import bird_x
    has_bird = bird_x.is_bird_installed() and bird_x.is_bird_authenticated()

    has_sc_x = bool(config.get('SCRAPECREATORS_API_KEY'))
    has_x = has_xai or has_bird or has_sc_x

    if has_reddit and has_x and has_web:
        return 'none'
    elif has_reddit and has_x:
        return 'web'  # Missing web search keys
    elif has_reddit and has_web:
        return 'x'  # Missing X source
    elif has_reddit:
        return 'x'  # Missing X source (and possibly web)
    return 'all'


def validate_sources(requested: str, available: str, include_web: bool = False) -> tuple[str, Optional[str]]:
    """Validate requested sources against available keys.

    Args:
        requested: 'auto', 'reddit', 'x', 'both', or 'web'
        available: Result from get_available_sources()
        include_web: If True, add WebSearch to available sources

    Returns:
        Tuple of (effective_sources, error_message)
    """
    has_reddit = available in ('reddit', 'both', 'reddit-web', 'all')
    has_x = available in ('x', 'both', 'x-web', 'all')
    has_web = available in ('web', 'reddit-web', 'x-web', 'all')

    if requested == 'auto':
        if has_reddit and has_x:
            base = 'both'
        elif has_reddit:
            base = 'reddit'
        elif has_x:
            base = 'x'
        elif has_web:
            base = 'web'
        else:
            return 'none', "No sources are available."

        if include_web:
            if base == 'both':
                return 'all', None
            if base == 'reddit':
                return 'reddit-web', None
            if base == 'x':
                return 'x-web', None
        return base, None

    if requested == 'web':
        return 'web', None

    if requested == 'both':
        if not (has_reddit and has_x):
            return 'none', "Requested both sources but X source is missing."
        if include_web:
            return 'all', None
        return 'both', None

    if requested == 'reddit':
        if not has_reddit:
            return 'none', "Requested Reddit but only xAI key is available."
        if include_web:
            return 'reddit-web', None
        return 'reddit', None

    if requested == 'x':
        if not has_x:
            return 'none', "Requested X but no X source is available (need Bird auth or XAI_API_KEY)."
        if include_web:
            return 'x-web', None
        return 'x', None

    return requested, None


def get_x_source(config: Dict[str, Any]) -> Optional[str]:
    """Determine the best available X/Twitter source.

    Priority: Bird (free) → xAI (paid API) → ScrapeCreators (shared key)

    Args:
        config: Configuration dict from get_config()

    Returns:
        'bird' if Bird is installed and authenticated,
        'xai' if XAI_API_KEY is configured,
        'scrapecreators' if SCRAPECREATORS_API_KEY is configured,
        None if no X source available.
    """
    # Import here to avoid circular dependency
    from . import bird_x

    # Check Bird first (free option)
    if bird_x.is_bird_installed():
        username = bird_x.is_bird_authenticated()
        if username:
            return 'bird'

    # Fall back to xAI if key exists
    if config.get('XAI_API_KEY'):
        return 'xai'

    # Fall back to ScrapeCreators (same key as Reddit/TikTok/Instagram)
    if config.get('SCRAPECREATORS_API_KEY'):
        return 'scrapecreators'

    return None


def is_ytdlp_available() -> bool:
    """Check if yt-dlp is installed for YouTube search."""
    from . import youtube_yt
    return youtube_yt.is_ytdlp_installed()


def is_hackernews_available() -> bool:
    """Check if Hacker News source is available.

    Always returns True - HN uses free Algolia API, no key needed.
    """
    return True


def is_bluesky_available(config: Dict[str, Any]) -> bool:
    """Check if Bluesky source is available.

    Requires BSKY_HANDLE and BSKY_APP_PASSWORD (app password from bsky.app/settings).
    """
    return bool(config.get('BSKY_HANDLE') and config.get('BSKY_APP_PASSWORD'))


def is_truthsocial_available(config: Dict[str, Any]) -> bool:
    """Check if Truth Social source is available.

    Requires TRUTHSOCIAL_TOKEN (bearer token from browser dev tools).
    """
    return bool(config.get('TRUTHSOCIAL_TOKEN'))


def is_polymarket_available() -> bool:
    """Check if Polymarket source is available.

    Always returns True - Gamma API is free, no key needed.
    """
    return True


def is_tiktok_available(config: Dict[str, Any]) -> bool:
    """Check if TikTok source is available (ScrapeCreators or legacy Apify).

    Returns True if SCRAPECREATORS_API_KEY or APIFY_API_TOKEN is set.
    """
    return bool(config.get('SCRAPECREATORS_API_KEY') or config.get('APIFY_API_TOKEN'))


def get_tiktok_token(config: Dict[str, Any]) -> str:
    """Get TikTok API token, preferring ScrapeCreators over legacy Apify."""
    return config.get('SCRAPECREATORS_API_KEY') or config.get('APIFY_API_TOKEN') or ''


def is_instagram_available(config: Dict[str, Any]) -> bool:
    """Check if Instagram source is available (ScrapeCreators).

    Returns True if SCRAPECREATORS_API_KEY is set.
    Instagram uses the same key as TikTok.
    """
    return bool(config.get('SCRAPECREATORS_API_KEY'))


def get_instagram_token(config: Dict[str, Any]) -> str:
    """Get Instagram API token (same ScrapeCreators key as TikTok)."""
    return config.get('SCRAPECREATORS_API_KEY') or ''


def get_xiaohongshu_api_base(config: Dict[str, Any]) -> str:
    """Get Xiaohongshu HTTP API base URL.

    Defaults to host.docker.internal so OpenClaw Docker can reach host service.
    """
    return (config.get('XIAOHONGSHU_API_BASE') or "http://host.docker.internal:18060").rstrip("/")


def is_xiaohongshu_available(config: Dict[str, Any]) -> bool:
    """Check whether Xiaohongshu HTTP API is reachable and logged in."""
    # Import here to avoid heavy imports at module load.
    from . import http

    base = get_xiaohongshu_api_base(config)
    try:
        # Keep health probe snappy, but allow one retry for transient hiccups.
        health = http.get(f"{base}/health", timeout=3, retries=2)
        if not isinstance(health, dict):
            return False
        if not health.get("success"):
            return False

        # Login probe can be slower on some deployments (browser/session checks),
        # so use a slightly longer timeout to avoid false negatives.
        login = http.get(f"{base}/api/v1/login/status", timeout=8, retries=2)
        is_logged_in = (
            login.get("data", {}).get("is_logged_in")
            if isinstance(login, dict) else False
        )
        return bool(is_logged_in)
    except Exception:
        return False


# Backward compat alias
is_apify_available = is_tiktok_available


def get_x_source_status(config: Dict[str, Any]) -> Dict[str, Any]:
    """Get detailed X source status for UI decisions.

    Returns:
        Dict with keys: source, bird_installed, bird_authenticated,
        bird_username, xai_available, can_install_bird
    """
    from . import bird_x

    bird_status = bird_x.get_bird_status()
    xai_available = bool(config.get('XAI_API_KEY'))

    sc_available = bool(config.get('SCRAPECREATORS_API_KEY'))

    # Determine active source
    if bird_status["authenticated"]:
        source = 'bird'
    elif xai_available:
        source = 'xai'
    elif sc_available:
        source = 'scrapecreators'
    else:
        source = None

    return {
        "source": source,
        "bird_installed": bird_status["installed"],
        "bird_authenticated": bird_status["authenticated"],
        "bird_username": bird_status["username"],
        "xai_available": xai_available,
        "scrapecreators_available": sc_available,
        "can_install_bird": bird_status["can_install"],
    }
