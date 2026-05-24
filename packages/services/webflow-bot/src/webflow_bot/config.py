"""Environment-derived constants shared across modules.

Defined here (not in __main__.py) so any module can pull the same values
without circular imports through the entry point.
"""

from __future__ import annotations

import os
import sys

PROFILE_DIR = os.environ.get("PROFILE_DIR", "/config/playwright-profile")
SITE_URL = os.environ.get("SITE_URL", "https://lisa-blockcast.design.webflow.com/")
DASHBOARD_URL = "https://webflow.com/dashboard"
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "900"))
EMAIL = os.environ.get("WEBFLOW_EMAIL", "")
PASSWORD = os.environ.get("WEBFLOW_PASSWORD", "")
CONTROL_PORT = int(os.environ.get("CONTROL_PORT", "7000"))
CONTROL_TOKEN = os.environ.get("CONTROL_TOKEN", "")
PROXY_URL = os.environ.get("WEBFLOW_BOT_PROXY", "")

STATE_FILE = os.path.join(PROFILE_DIR, "camoufox-storage-state.json")


def assert_credentials_present() -> None:
    """Fail fast at boot if WEBFLOW_EMAIL/PASSWORD are missing.

    Pulled out of module-import-time so tests can import this module without
    a sys.exit(2) sabotage in CI.
    """
    if not EMAIL or not PASSWORD:
        print("FATAL: WEBFLOW_EMAIL/WEBFLOW_PASSWORD not set", file=sys.stderr)
        sys.exit(2)
