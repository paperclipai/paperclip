"""
Flask application factory for the EMR Dashboard.
"""

import logging
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flask import Flask
from keychain_helper import keychain_secret

from emr_automation.database import remove_session
from emr_automation.openai_auth import has_openai_oauth_config

try:
    from flask_cors import CORS
except ImportError:  # pragma: no cover - production requirements include flask-cors
    def CORS(*args, **kwargs):
        logger.warning("flask-cors is not installed; CORS headers are disabled")
        return None

if TYPE_CHECKING:
    from emr_automation.core import EMRAutomation

logger = logging.getLogger("emr_automation.dashboard")


def _fail_loud_if_openai_missing() -> None:
    """
    Fail at boot if OpenAI credentials are missing, instead of per-request
    RuntimeError at transcribe_audio() when a doctor records their first patient.

    History: on 2026-04-24 an overnight `.env` restore stripped OPENAI_OAUTH_ACCESS_TOKEN
    on both the MacBook and Mac Mini. Flask booted cleanly, passed health checks, and
    only died with "OpenAI OAuth not configured" when voice recording was attempted.
    Having this check at startup turns a silent landmine into a loud, immediate failure
    that `launchctl kickstart -k` surfaces in cloud-api-error.log before the next shift.

    Opt-out: set ALLOW_MISSING_OPENAI=1 for test runs or dashboard-only deployments
    that don't need the transcription endpoints.
    """
    if os.environ.get("ALLOW_MISSING_OPENAI") == "1":
        return
    if has_openai_oauth_config():
        return

    sys.stderr.write(
        "\n"
        "=" * 72 + "\n"
        "STARTUP ABORT: OpenAI OAuth not configured\n"
        "=" * 72 + "\n"
        "has_openai_oauth_config() returned False. Transcription endpoints\n"
        "(/api/transcribe, /api/suggest-cid, /api/format-soap) would fail on every\n"
        "request. Refusing to start.\n"
        "\n"
        "Fix: populate one of these in the Flask process environment or `.env`:\n"
        "  OPENAI_OAUTH_ACCESS_TOKEN=sk-proj-...          (simplest — SDK accepts\n"
        "                                                   plain API keys as bearer)\n"
        "OR the full OAuth client-credentials triple:\n"
        "  OPENAI_OAUTH_TOKEN_URL=...\n"
        "  OPENAI_OAUTH_CLIENT_ID=...\n"
        "  OPENAI_OAUTH_CLIENT_SECRET=...\n"
        "\n"
        "Durable backup on the Mac Mini keychain:\n"
        "  security find-generic-password -s openai-api-key-pediatrics -w\n"
        "\n"
        "To start anyway (dashboard-only, no transcription): ALLOW_MISSING_OPENAI=1\n"
        "=" * 72 + "\n"
    )
    sys.stderr.flush()
    sys.exit(1)


def _resolve_cors_origins() -> list:
    """
    Resolve the allowed CORS origins, failing loudly at boot if unset.

    Security (CHRA-2135, from the CHRA-2080 audit 2026-05-29): the dashboard mounts
    CORS on /api/* with allow_private_network=True, which lets a browser send
    credentialed Private Network Access requests from a public page to the local
    Mac Mini API. The previous ``os.environ.get("CORS_ORIGINS", "*")`` default meant
    that whenever CORS_ORIGINS was absent from the environment (e.g. the 2026-04-24
    overnight `.env` restore that stripped other vars — see
    _fail_loud_if_openai_missing) ANY website could call the API from a victim's
    browser. We now refuse to start rather than silently fall back to a wildcard.

    Production values live in backend/.env.example, e.g.:
      CORS_ORIGINS=chrome-extension://<EXT_ID>,https://api.tocafichadr.com.br
    For local development set it to your unpacked extension's chrome-extension://
    origin. To deliberately allow every origin (never in production) set
    CORS_ORIGINS=* explicitly — the wildcard then becomes a visible, audited choice
    rather than a silent default, and is logged as CRITICAL below.
    """
    origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
    if not origins:
        raise RuntimeError(
            "CORS_ORIGINS must be set (no wildcard default). The dashboard enables "
            "CORS on /api/* with allow_private_network=True; without an explicit "
            "allow-list any web page could make credentialed requests to the local "
            "API. Set e.g. CORS_ORIGINS=chrome-extension://<EXT_ID>,"
            "https://api.tocafichadr.com.br (production values are in .env.example). "
            "For local dev use your unpacked extension's chrome-extension:// origin; "
            "to deliberately allow all origins set CORS_ORIGINS=* explicitly."
        )
    if "*" in origins:
        logger.critical(
            "CORS_ORIGINS contains a wildcard '*' while allow_private_network is "
            "enabled; any web origin can make credentialed requests to the local API. "
            "Use explicit chrome-extension:// / https origins in production."
        )
    return origins


def create_app(
    emr: Optional["EMRAutomation"] = None,
    config_path: Optional[str] = None,
) -> Flask:
    """
    Create and configure the Flask dashboard application.

    Args:
        emr: Optional EMRAutomation instance to bind for live control.
        config_path: Path to config.ini (defaults to project root).
    """
    # Abort at boot if OpenAI config is missing — see _fail_loud_if_openai_missing
    # docstring for rationale (2026-04-24 incident). This runs BEFORE Flask is
    # constructed so the error lands in cloud-api-error.log, not in a request handler.
    _fail_loud_if_openai_missing()

    template_dir = Path(__file__).parent / "templates"
    static_dir = Path(__file__).parent / "static"

    app = Flask(
        __name__,
        template_folder=str(template_dir),
        static_folder=str(static_dir),
    )

    try:
        app.config["SECRET_KEY"] = keychain_secret("pedbot-secret-key")
    except SystemExit:
        app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "")
    if not app.config["SECRET_KEY"]:
        raise RuntimeError("SECRET_KEY not found in keychain or environment")

    app.config["DEBUG"] = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.config["MAX_CONTENT_LENGTH"] = int(
        os.environ.get("TOCAFICHADR_MAX_CONTENT_LENGTH", str(25 * 1024 * 1024))
    )

    cors_origins = _resolve_cors_origins()
    # allow_private_network=True is required for Chrome 104+ Private Network Access (PNA).
    # Without it, POST requests from the extension (HTTPS origin → http://localhost)
    # are blocked by the browser's preflight check. GET /api/health bypasses this
    # because simple GET requests don't trigger a preflight. flask_cors 6.x supports
    # allow_private_network natively; it sets Access-Control-Allow-Private-Network: true.
    CORS(app, resources={r"/api/*": {"origins": cors_origins, "allow_private_network": True}})

    @app.teardown_appcontext
    def _remove_db_session(_exception=None):
        remove_session()

    # Store references accessible to routes
    app.config["EMR_INSTANCE"] = emr
    app.config["CONFIG_PATH"] = config_path or str(
        Path(__file__).resolve().parent.parent.parent / "config.ini"
    )

    # Register routes
    from emr_automation.dashboard.routes import bp, broadcast_event
    app.register_blueprint(bp)

    # Phase 2: Auth and billing blueprints (safe to register even if not used)
    try:
        from emr_automation.dashboard.routes_auth import auth_bp
        from emr_automation.dashboard.routes_billing import billing_bp
        app.register_blueprint(auth_bp)
        app.register_blueprint(billing_bp)
    except ImportError:
        pass  # Phase 2 dependencies not installed yet

    # v3.0.4: Clerk webhook blueprint (separate try so a missing svix dep doesn't
    # block billing registration).
    try:
        from emr_automation.dashboard.routes_clerk import clerk_bp
        app.register_blueprint(clerk_bp)
    except ImportError as e:
        logger.warning("clerk webhook blueprint not registered: %s", e)

    # Wire up patient-changed callback on the EMR instance so core.py can push
    # SSE events without importing from the dashboard package (avoids circular imports).
    if emr is not None:
        def _on_patient_changed(data: dict) -> None:
            try:
                with app.app_context():
                    broadcast_event("patient_changed", data)
            except Exception:
                pass

        emr.on_patient_changed = _on_patient_changed

    # Auto-create database tables on startup
    try:
        from emr_automation.database import init_db
        init_db()
    except Exception as exc:
        logger.warning("Could not initialise database on startup: %s", exc)

    logger.info("Dashboard app created (config: %s)", app.config["CONFIG_PATH"])
    return app
