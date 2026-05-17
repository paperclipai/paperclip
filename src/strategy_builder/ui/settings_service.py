"""
Settings Service — BTC Trade Engine Strategy Builder

Provides secure persistence for application settings:
- User-editable settings (API keys, preferences) stored in OS keyring
- Admin-only settings (DB config, performance tuning) stored in OS keyring
- Admin PIN stored as bcrypt hash in keyring (never plaintext)
- Non-secret settings stored in .env file via python-dotenv

Security architecture per BTCAAAAA-79 SecurityAnalyst recommendations:
  - OS keyring (GNOME Keyring / Keychain / Windows Credential Manager) for all
    secret fields — no plaintext secrets written to .env via the UI save path
  - bcrypt PIN hash for admin role gate — hash stored in keyring
  - .env file permissions enforced to 600 on every save

Author: UIEngineer (BTCAAAAA-80)
"""

from __future__ import annotations

import enum
import os
import stat
from typing import Any, Optional

import bcrypt
import keyring
from dotenv import load_dotenv, set_key

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

KEYRING_SERVICE = "btc-trade-engine"
ENV_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)
    )))),
    ".env"
)

# Secret field names stored in keyring (never written to .env)
SECRET_KEYS = {
    "OPENROUTER_API_KEY",
    "LAKEAPI_KEY",
    "LAKEAPI_SECRET",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "POSTGRES_PASSWORD",
    "POSTGRES_SSL_CERT_PATH",
    "POSTGRES_SSL_KEY_PATH",
}

# Admin-only settings (hidden from user role)
ADMIN_ONLY_KEYS = {
    # --- Database connection ---
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    # --- DB connection pool ---
    "POSTGRES_POOL_SIZE",
    "POSTGRES_MAX_OVERFLOW",
    "POSTGRES_POOL_TIMEOUT",
    "POSTGRES_POOL_RECYCLE",
    # --- DB SSL ---
    "POSTGRES_SSL",
    "POSTGRES_SSL_CERT_PATH",
    "POSTGRES_SSL_KEY_PATH",
    # --- DB monitoring ---
    "POSTGRES_LOG_MIN_DURATION",
    "POSTGRES_LOG_CONNECTIONS",
    "POSTGRES_LOG_DISCONNECTIONS",
    # --- Backup ---
    "POSTGRES_BACKUP_PATH",
    "POSTGRES_BACKUP_RETENTION_DAYS",
    "POSTGRES_BACKUP_COMPRESSION",
    # --- Risk management ---
    "RISK_MIN_REWARD_RATIO",
    "RISK_PERCENT",
    "RISK_MAX_LEVERAGE",
    "RISK_MIN_CONFLUENCE",
    "RISK_MAX_BARS_HELD",
    "RISK_MAX_DRAWDOWN",
    "RISK_MIN_WIN_RATE",
    "RISK_MIN_PROFIT_FACTOR",
    "RISK_MAX_CORRELATION",
    "RISK_MAX_EXPOSURE",
    "EMERGENCY_SL_ENABLED",
    "EMERGENCY_SL_THRESHOLD",
    "EMERGENCY_SL_VOLATILITY_LOOKBACK",
    "EMERGENCY_SL_VOLATILITY_MULTIPLIER",
    "TP_FIBONACCI_LEVELS",
    "TP_FIBONACCI_ADJUSTMENT_THRESHOLD",
    "TP_HYBRID_ATR_MULTIPLIER",
    "TP_HYBRID_MIN_DISTANCE",
    "TP_FIXED_DISTANCES",
    "SL_ADAPTIVE_ATR_PERIOD",
    "SL_ADAPTIVE_ATR_MULTIPLIER",
    "SL_ADAPTIVE_MIN_DISTANCE",
    "SL_STATIC_DISTANCE",
    # --- Strategy / optimization ---
    "OPTIMIZATION_RISK_REWARD_MIN",
    "OPTIMIZATION_RISK_REWARD_MAX",
    "OPTIMIZATION_RISK_PERCENT_MIN",
    "OPTIMIZATION_RISK_PERCENT_MAX",
    "OPTIMIZATION_CONFLUENCE_MIN",
    "OPTIMIZATION_CONFLUENCE_MAX",
    "OPTIMIZATION_BARS_HELD_MIN",
    "OPTIMIZATION_BARS_HELD_MAX",
    "OPTIMIZATION_VOLATILITY_MULTIPLIER_MIN",
    "OPTIMIZATION_VOLATILITY_MULTIPLIER_MAX",
    "OPTIMIZATION_SL_DISTANCE_MIN",
    "OPTIMIZATION_SL_DISTANCE_MAX",
    "METRICS_SHARPE_WINDOW",
    "METRICS_SORTINO_WINDOW",
    "METRICS_CALMAR_WINDOW",
    "METRICS_MIN_TRADES",
    "METRICS_CONFIDENCE_LEVEL",
    "RISK_VAR_CONFIDENCE",
    "RISK_VAR_WINDOW",
    "RISK_ES_CONFIDENCE",
    "RISK_MONTE_CARLO_SIMS",
    "RISK_DRAWDOWN_WINDOW",
    "RISK_CORRELATION_WINDOW",
    "TRADE_MIN_SAMPLE_SIZE",
    "TRADE_PATTERN_CONFIDENCE",
    "TRADE_CLUSTER_THRESHOLD",
    "TRADE_QUALITY_WINDOW",
    "TRADE_SLIPPAGE_THRESHOLD",
    "TRADE_COMMISSION_IMPACT_THRESHOLD",
    "CAPITAL_EFFICIENCY_TARGET",
    "CAPITAL_FREE_MARGIN_TARGET",
    "CAPITAL_MAX_USAGE_LIMIT",
    "CAPITAL_TURNOVER_TARGET",
    "CAPITAL_CURVE_SMOOTHNESS",
    "WEIGHT_SHARPE_RATIO",
    "WEIGHT_SORTINO_RATIO",
    "WEIGHT_CALMAR_RATIO",
    "WEIGHT_WIN_RATE",
    "WEIGHT_PROFIT_FACTOR",
    "WEIGHT_MAX_DRAWDOWN",
    "WEIGHT_CAPITAL_EFFICIENCY",
    "WEIGHT_TRADE_QUALITY",
    # --- State management ---
    "STATE_SAVE_INTERVAL",
    "STATE_MAX_HISTORY",
    "STATE_COMPRESSION",
    "STATE_BACKUP_COUNT",
    "STATE_VALIDATION_LEVEL",
    # --- Training system ---
    "TRAINING_MAX_LOOKBACK",
    "TRAINING_MIN_SIGNALS",
    "TRAINING_MAX_TIMEFRAMES",
    "TRAINING_BATCH_SIZE",
    "TRAINING_PARALLEL_BLOCKS",
    # --- Resource thresholds ---
    "RESOURCE_CHECK_INTERVAL",
    "RESOURCE_WARNING_THRESHOLD",
    "RESOURCE_CRITICAL_THRESHOLD",
    "RESOURCE_AUTO_CLEANUP",
    "RESOURCE_HISTORY_LENGTH",
    # --- Legacy admin-only (kept for backwards compat) ---
    "STRATEGY_ANALYSIS_LOG_LEVEL",
}

# User-editable settings (always visible)
USER_KEYS = {
    # API keys (secret)
    "OPENROUTER_API_KEY",
    "LAKEAPI_KEY",
    "LAKEAPI_SECRET",
    # AI provider config
    "AI_PROVIDER",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_MODEL",
    "ANTHROPIC_MODEL",
    "OPENAI_MODEL",
    "OLLAMA_BASE_URL",
    "OLLAMA_MODEL",
    # AI config
    "AI_MODEL",
    # Data & API (non-secret)
    "LAKEAPI_REGION",
    "LAKEAPI_LIMIT_GB",
    # Performance & Resources
    "MULTICORE_WORKERS",
    "MEMORY_LIMIT_GB",
    "CPU_CORES_MIN",
    "CPU_CORES_MAX",
    "CPU_AFFINITY_MODE",
    "MEMORY_CHART_HISTORY",
    "UPDATE_INTERVAL",
    # Alerts & Logging
    "ENABLE_ALERTS",
    "LOG_LEVEL",
    # UI Preferences
    "DARK_THEME_ENABLED",
    "UI_THEME",
    # Contact
    "ALERT_EMAIL",
}

# Default non-secret user-editable values
USER_DEFAULTS = {
    "AI_PROVIDER": "openrouter",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    "OPENAI_MODEL": "gpt-4o",
    "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
    "DEEPSEEK_MODEL": "deepseek-chat",
    "OLLAMA_BASE_URL": "http://localhost:11434",
    "OLLAMA_MODEL": "llama3",
    "AI_MODEL": "anthropic/claude-4.5-sonnet",
    "LAKEAPI_REGION": "eu-west-1",
    "LAKEAPI_LIMIT_GB": "300",
    "MULTICORE_WORKERS": "",
    "MEMORY_LIMIT_GB": "",
    "CPU_CORES_MIN": "1",
    "CPU_CORES_MAX": "auto",
    "CPU_AFFINITY_MODE": "automatic",
    "MEMORY_CHART_HISTORY": "60",
    "UPDATE_INTERVAL": "1000",
    "ENABLE_ALERTS": "false",
    "LOG_LEVEL": "INFO",
    "DARK_THEME_ENABLED": "true",
    "UI_THEME": "dark",
    "ALERT_EMAIL": "",
}

# Default non-secret admin-editable values
ADMIN_DEFAULTS = {
    # DB connection
    "POSTGRES_HOST": "localhost",
    "POSTGRES_PORT": "5432",
    "POSTGRES_DB": "optimizer_v3",
    "POSTGRES_USER": "optimizer_admin",
    # DB connection pool
    "POSTGRES_POOL_SIZE": "10",
    "POSTGRES_MAX_OVERFLOW": "20",
    "POSTGRES_POOL_TIMEOUT": "30",
    "POSTGRES_POOL_RECYCLE": "3600",
    # DB SSL
    "POSTGRES_SSL": "false",
    "POSTGRES_SSL_CERT_PATH": "",
    "POSTGRES_SSL_KEY_PATH": "",
    # DB monitoring
    "POSTGRES_LOG_MIN_DURATION": "1000",
    "POSTGRES_LOG_CONNECTIONS": "false",
    "POSTGRES_LOG_DISCONNECTIONS": "false",
    # Backup
    "POSTGRES_BACKUP_PATH": "",
    "POSTGRES_BACKUP_RETENTION_DAYS": "30",
    "POSTGRES_BACKUP_COMPRESSION": "true",
    # Risk management
    "RISK_MIN_REWARD_RATIO": "2.0",
    "RISK_PERCENT": "1.0",
    "RISK_MAX_LEVERAGE": "1.0",
    "RISK_MIN_CONFLUENCE": "2",
    "RISK_MAX_BARS_HELD": "20",
    "RISK_MAX_DRAWDOWN": "0.02",
    "RISK_MIN_WIN_RATE": "0.55",
    "RISK_MIN_PROFIT_FACTOR": "1.5",
    "RISK_MAX_CORRELATION": "0.7",
    "RISK_MAX_EXPOSURE": "0.1",
    "EMERGENCY_SL_ENABLED": "true",
    "EMERGENCY_SL_THRESHOLD": "3.0",
    "EMERGENCY_SL_VOLATILITY_LOOKBACK": "14",
    "EMERGENCY_SL_VOLATILITY_MULTIPLIER": "2.0",
    "TP_FIBONACCI_LEVELS": "[1.618, 2.618, 3.618]",
    "TP_FIBONACCI_ADJUSTMENT_THRESHOLD": "0.01",
    "TP_HYBRID_ATR_MULTIPLIER": "2.0",
    "TP_HYBRID_MIN_DISTANCE": "0.005",
    "TP_FIXED_DISTANCES": "[0.01, 0.02, 0.03]",
    "SL_ADAPTIVE_ATR_PERIOD": "14",
    "SL_ADAPTIVE_ATR_MULTIPLIER": "2.0",
    "SL_ADAPTIVE_MIN_DISTANCE": "0.005",
    "SL_STATIC_DISTANCE": "0.01",
    # Strategy / optimization
    "OPTIMIZATION_RISK_REWARD_MIN": "1.5",
    "OPTIMIZATION_RISK_REWARD_MAX": "3.0",
    "OPTIMIZATION_RISK_PERCENT_MIN": "0.5",
    "OPTIMIZATION_RISK_PERCENT_MAX": "2.0",
    "OPTIMIZATION_CONFLUENCE_MIN": "1",
    "OPTIMIZATION_CONFLUENCE_MAX": "3",
    "OPTIMIZATION_BARS_HELD_MIN": "10",
    "OPTIMIZATION_BARS_HELD_MAX": "30",
    "OPTIMIZATION_VOLATILITY_MULTIPLIER_MIN": "1.5",
    "OPTIMIZATION_VOLATILITY_MULTIPLIER_MAX": "2.5",
    "OPTIMIZATION_SL_DISTANCE_MIN": "0.003",
    "OPTIMIZATION_SL_DISTANCE_MAX": "0.025",
    "METRICS_SHARPE_WINDOW": "252",
    "METRICS_SORTINO_WINDOW": "252",
    "METRICS_CALMAR_WINDOW": "252",
    "METRICS_MIN_TRADES": "30",
    "METRICS_CONFIDENCE_LEVEL": "0.95",
    "RISK_VAR_CONFIDENCE": "0.99",
    "RISK_VAR_WINDOW": "10",
    "RISK_ES_CONFIDENCE": "0.975",
    "RISK_MONTE_CARLO_SIMS": "10000",
    "RISK_DRAWDOWN_WINDOW": "252",
    "RISK_CORRELATION_WINDOW": "60",
    "TRADE_MIN_SAMPLE_SIZE": "50",
    "TRADE_PATTERN_CONFIDENCE": "0.95",
    "TRADE_CLUSTER_THRESHOLD": "0.5",
    "TRADE_QUALITY_WINDOW": "30",
    "TRADE_SLIPPAGE_THRESHOLD": "0.001",
    "TRADE_COMMISSION_IMPACT_THRESHOLD": "0.002",
    "CAPITAL_EFFICIENCY_TARGET": "0.8",
    "CAPITAL_FREE_MARGIN_TARGET": "0.3",
    "CAPITAL_MAX_USAGE_LIMIT": "0.9",
    "CAPITAL_TURNOVER_TARGET": "12",
    "CAPITAL_CURVE_SMOOTHNESS": "0.7",
    "WEIGHT_SHARPE_RATIO": "0.20",
    "WEIGHT_SORTINO_RATIO": "0.15",
    "WEIGHT_CALMAR_RATIO": "0.15",
    "WEIGHT_WIN_RATE": "0.10",
    "WEIGHT_PROFIT_FACTOR": "0.10",
    "WEIGHT_MAX_DRAWDOWN": "0.10",
    "WEIGHT_CAPITAL_EFFICIENCY": "0.10",
    "WEIGHT_TRADE_QUALITY": "0.10",
    # State management
    "STATE_SAVE_INTERVAL": "300",
    "STATE_MAX_HISTORY": "100",
    "STATE_COMPRESSION": "true",
    "STATE_BACKUP_COUNT": "3",
    "STATE_VALIDATION_LEVEL": "strict",
    # Training system
    "TRAINING_MAX_LOOKBACK": "180",
    "TRAINING_MIN_SIGNALS": "50",
    "TRAINING_MAX_TIMEFRAMES": "5",
    "TRAINING_BATCH_SIZE": "1000",
    "TRAINING_PARALLEL_BLOCKS": "4",
    # Resource thresholds
    "RESOURCE_CHECK_INTERVAL": "60",
    "RESOURCE_WARNING_THRESHOLD": "80",
    "RESOURCE_CRITICAL_THRESHOLD": "90",
    "RESOURCE_AUTO_CLEANUP": "true",
    "RESOURCE_HISTORY_LENGTH": "1440",
}


# ---------------------------------------------------------------------------
# Role enum
# ---------------------------------------------------------------------------

class UserRole(enum.Enum):
    USER = "user"
    ADMIN = "admin"


# ---------------------------------------------------------------------------
# SettingsService
# ---------------------------------------------------------------------------

class SettingsService:
    """
    Central service for loading, saving, and securing application settings.

    Secrets are stored in the OS keyring; non-secret settings go to .env.
    Admin access is gated by a PIN hash stored in the keyring.
    """

    def __init__(self) -> None:
        self._role: UserRole = UserRole.USER
        load_dotenv(ENV_FILE, override=False)

    # ------------------------------------------------------------------
    # Role / authentication
    # ------------------------------------------------------------------

    @property
    def role(self) -> UserRole:
        return self._role

    def is_admin(self) -> bool:
        return self._role == UserRole.ADMIN

    def authenticate_admin(self, pin: str) -> bool:
        """
        Verify PIN and elevate to ADMIN role if correct.

        .. deprecated::
            Prefer :meth:`elevate_to_admin` which is the canonical public
            entry-point for PIN-based role elevation.  This method is kept
            for backwards compatibility and delegates to ``elevate_to_admin``.

        Returns True if authentication succeeded, False otherwise.
        Stores nothing to disk — session role only.
        """
        return self.elevate_to_admin(pin)

    def elevate_to_admin(self, pin: str) -> bool:
        """
        Validate *pin* against the stored bcrypt hash and, on success,
        elevate the session role to ADMIN.

        This is the **single authorised entry-point** for granting admin
        access via PIN.  No external caller should write ``_role`` directly.

        Returns:
            ``True``  — PIN matched; session role is now ADMIN.
            ``False`` — PIN wrong or no PIN stored; role unchanged.

        Stores nothing to disk — session role only.
        """
        stored_hash = keyring.get_password(KEYRING_SERVICE, "admin_pin_hash")
        if not stored_hash:
            # No PIN set yet — first-time setup path
            return False
        try:
            ok = bcrypt.checkpw(pin.encode("utf-8"), stored_hash.encode("utf-8"))
            if ok:
                self._role = UserRole.ADMIN
            return ok
        except Exception:
            return False

    def elevate_to_admin_first_run(self) -> None:
        """
        Temporarily grant ADMIN role for the first-run PIN-setup flow.

        Only valid when **no** admin PIN has been stored yet.  Raises
        ``PermissionError`` if a PIN already exists (use
        :meth:`elevate_to_admin` in that case).

        The caller is responsible for calling :meth:`drop_admin` if the
        subsequent :meth:`set_admin_pin` call fails.
        """
        if self.has_admin_pin():
            raise PermissionError(
                "elevate_to_admin_first_run() is only valid before a PIN is set. "
                "Use elevate_to_admin(pin) to authenticate with an existing PIN."
            )
        self._role = UserRole.ADMIN

    def drop_admin(self) -> None:
        """Revoke admin session — returns role to USER."""
        self._role = UserRole.USER

    def set_admin_pin(self, new_pin: str) -> None:
        """
        Set (or change) the admin PIN.  Requires caller to already be ADMIN
        or there must be no existing PIN (first-run setup).

        Stores bcrypt hash in OS keyring — never in .env.
        """
        if not self.is_admin():
            existing = keyring.get_password(KEYRING_SERVICE, "admin_pin_hash")
            if existing:
                raise PermissionError("Must be admin to change the PIN")
        hashed = bcrypt.hashpw(new_pin.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        keyring.set_password(KEYRING_SERVICE, "admin_pin_hash", hashed)

    def has_admin_pin(self) -> bool:
        """Return True if an admin PIN has been configured."""
        return keyring.get_password(KEYRING_SERVICE, "admin_pin_hash") is not None

    # ------------------------------------------------------------------
    # Reading settings
    # ------------------------------------------------------------------

    def get(self, key: str) -> Optional[str]:
        """
        Read a setting value.

        - Secret keys: read from keyring
        - Non-secret keys: read from environment / .env
        """
        self._check_access(key)
        if key in SECRET_KEYS:
            return keyring.get_password(KEYRING_SERVICE, key)
        return os.getenv(key)

    def get_with_default(self, key: str, default: str = "") -> str:
        value = self.get(key)
        if value is None:
            return default
        return value

    def get_masked(self, key: str) -> str:
        """
        Return a masked representation for UI display (last 4 chars visible).

        Example: "sk-or-v1-...ac84"  →  "••••••••••••••••ac84"
        Returns empty string if no value stored.
        """
        self._check_access(key)
        value: Optional[str]
        if key in SECRET_KEYS:
            value = keyring.get_password(KEYRING_SERVICE, key)
        else:
            value = os.getenv(key)

        if not value:
            return ""
        if len(value) <= 4:
            return "•" * len(value)
        return "•" * (len(value) - 4) + value[-4:]

    # ------------------------------------------------------------------
    # Writing settings
    # ------------------------------------------------------------------

    def set(self, key: str, value: str) -> None:
        """
        Persist a setting value.

        - Secret keys: written to keyring ONLY (never to .env)
        - Non-secret keys: written to .env file; .env permissions set to 600
        """
        self._check_access(key)
        if key in SECRET_KEYS:
            keyring.set_password(KEYRING_SERVICE, key, value)
        else:
            set_key(ENV_FILE, key, value)
            self._enforce_env_permissions()
            # Reload so os.getenv picks up the new value in the current process
            load_dotenv(ENV_FILE, override=True)

    def save_user_settings(self, values: dict[str, str]) -> None:
        """
        Persist all user-editable settings in one call.

        values: {setting_key: new_value_or_sentinel}
        Sentinel "••••" (all bullets) means "unchanged — skip".
        """
        for key, value in values.items():
            if key not in USER_KEYS:
                continue
            if set(value) == {"•"}:
                # Masked sentinel — user did not change the field
                continue
            self.set(key, value)

    def save_admin_settings(self, values: dict[str, str]) -> None:
        """
        Persist all admin-editable settings in one call.

        Requires admin role.
        """
        if not self.is_admin():
            raise PermissionError("Admin role required to save admin settings")
        for key, value in values.items():
            if key not in ADMIN_ONLY_KEYS and key not in USER_KEYS:
                continue
            if set(value) == {"•"}:
                continue
            self.set(key, value)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _check_access(self, key: str) -> None:
        """Raise PermissionError if current role cannot access the key."""
        if key in ADMIN_ONLY_KEYS and not self.is_admin():
            raise PermissionError(
                f"Setting '{key}' requires admin role. "
                "Authenticate via the Admin section in Settings."
            )

    @staticmethod
    def _enforce_env_permissions() -> None:
        """Set .env file permissions to 600 (owner read/write only)."""
        if os.path.exists(ENV_FILE):
            try:
                os.chmod(ENV_FILE, stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass  # Non-fatal on read-only filesystems or non-POSIX
