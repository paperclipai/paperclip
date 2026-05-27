"""Shared mutable state for the bot.

Playwright sync_api binds its internal greenlet to the thread that created
the Camoufox/page objects (main thread). Cross-thread access raises
"Cannot switch to a different thread". So the HTTP server runs
SINGLE-THREADED in the main thread; health probes piggyback on
HTTPServer.service_actions() between requests rather than on a background
thread. `page_lock` is `RLock` for re-entry guards but there's only one
operating thread by construction.

All shared state lives behind module attributes here so any importer reads
the live values. Writers either mutate `status` (dict) in place or, for
scalar reassignment, use one of the setter helpers below — using `global`
across module boundaries doesn't work.
"""

from __future__ import annotations

import threading
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # TYPE_CHECKING guard lets `import state` succeed without Playwright
    # installed (e.g., in unit tests / lint CI that skip the Docker build).
    # Runtime modules that actually create / drive Pages import playwright
    # at their own top level — this module only USES Page as a type hint.
    from playwright.sync_api import BrowserContext, Page

# Single-threaded reentrant lock guarding all Page operations.
page_lock: threading.RLock = threading.RLock()

# The live Playwright Page + BrowserContext. None before `main()` boots
# Camoufox. Mutated by `set_page()` / `set_context()`.
page: Page | None = None
context: BrowserContext | None = None

# Status snapshot returned by GET /health. Mutated in place via dict ops
# so all importers see the same object.
status: dict[str, Any] = {"ready": False, "phase": "starting"}

# Health-probe cadence: monotonic-ish epoch of the last service_actions tick.
# Reassigned from control_plane.service_actions; mutated via set_last_health_at.
last_health_at: float = 0.0


def set_page(p: Page | None) -> None:
    """Assignment helper — `global` across modules doesn't work."""
    global page
    page = p


def set_context(c: BrowserContext | None) -> None:
    """Assignment helper — `global` across modules doesn't work."""
    global context
    context = c


def set_last_health_at(t: float) -> None:
    """Assignment helper — `global` across modules doesn't work."""
    global last_health_at
    last_health_at = t


def log(*m: Any) -> None:
    """Stdout-flushing log line with UTC timestamp.

    Kept here (not in a separate logging module) because everything else
    imports state anyway.
    """
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    print("[bot " + ts + "]", *m, flush=True)


def set_phase(phase: str) -> None:
    """Update the /health `phase` snapshot."""
    status["phase"] = phase
    status["phase_at"] = time.time()
