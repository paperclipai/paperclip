"""Environment-derived constants shared across figma-bot modules.

Defined here (not in __main__.py) so any module can pull the same values
without circular imports through the entry point.
"""

from __future__ import annotations

import os

PROFILE_DIR = os.environ.get("PROFILE_DIR", "/config/playwright-profile")
SITE_URL = os.environ.get("SITE_URL", "https://www.figma.com/files/recent")
REFRESH_SECONDS = int(os.environ.get("REFRESH_SECONDS", "900"))
EMAIL = os.environ.get("FIGMA_EMAIL", "")
CONTROL_PORT = int(os.environ.get("CONTROL_PORT", "7000"))
CONTROL_TOKEN = os.environ.get("CONTROL_TOKEN", "")
PROXY_URL = os.environ.get("FIGMA_BOT_PROXY", "")
JOB_TIMEOUT = float(os.environ.get("JOB_TIMEOUT", "30"))
DEFAULT_LEASE_TTL = int(os.environ.get("DEFAULT_LEASE_TTL", "300"))
JOB_POLL_INTERVAL = 1.0

IDENTITIES_PATH = os.environ.get(
    "FIGMA_IDENTITIES_PATH",
    "/etc/figma-identities/identities.json",
)
PROFILES_ROOT = os.environ.get("FIGMA_PROFILES_ROOT", "/config/profiles")

# Optional ccrotate-auth-bot endpoint for claim-only leases. When set,
# ProfileManager.launch() POSTs to {CCROTATE_LEASE_URL}/lease/claim with
# the identity it's about to use, and ProfileManager.close() DELETEs.
# The claim tells ccrotate's stale-poller to skip device-auth on this
# identity — see Blockcast/onprem-k8s#356 + #357 for the contract.
# Empty string disables the feature (graceful: no calls, no errors).
CCROTATE_LEASE_URL = os.environ.get("CCROTATE_LEASE_URL", "")
CCROTATE_LEASE_TTL_SEC = int(os.environ.get("CCROTATE_LEASE_TTL_SEC", "1800"))
CCROTATE_LEASE_AGENT = os.environ.get("CCROTATE_LEASE_AGENT", "figma-designer-bot")

# Pre-T6 layout — migration shim only.
LEGACY_PROFILE_DIR = "/config/playwright-profile"
LEGACY_BACKUP_DIR = "/config/playwright-profile-backup"

# RFB pointer-event injection (Camoufox isTrusted=false workaround). The
# 50ms hold matches a natural human click duration; longer values trigger
# Figma's long-press handlers, shorter ones get debounced.
_RFB_BUTTON_HOLD_S = 0.05
