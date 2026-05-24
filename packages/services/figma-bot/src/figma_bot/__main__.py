#!/usr/bin/env python3
"""
Figma Designer bot — multi-identity Camoufox session + HTTP control plane.

HTTP endpoints (auth: X-Control-Token; interaction endpoints also require
X-Lease-Id):

  GET  /health             liveness + login state + lease snapshot
  GET  /lease/status       current lease snapshot
  POST /lease/acquire      body: {client_id, identity?, ttl?}
  POST /lease/release      header X-Lease-Id
  POST /lease/heartbeat    header X-Lease-Id
  POST /screenshot         X-Lease-Id
  POST /eval               body: {expression}, X-Lease-Id
  POST /key                body: {key}, X-Lease-Id
  POST /click              body: {x, y}, X-Lease-Id
  POST /selectorClick      body: {selector}, X-Lease-Id
  POST /use_figma          body: {js}, X-Lease-Id  (M3 — 503 for now)

Architecture:
- Playwright sync_api is main-thread-only. The control server uses
  ThreadingHTTPServer for handler concurrency, but no handler ever
  touches `page.*` directly. All Playwright work routes through
  `state.job_queue` and is executed on the main thread by `drain_jobs_for`.
- Single-tenant lease: only one lease_id active at a time. A lease
  expires when (now - last_heartbeat) > ttl.
"""

from __future__ import annotations

import os
import signal
import sys
import threading
import time
from typing import Any

from . import state
from .config import (
    IDENTITIES_PATH,
    JOB_POLL_INTERVAL,
    PROFILE_DIR,
    PROFILES_ROOT,
    REFRESH_SECONDS,
)
from .control_plane import run_control_server
from .identity_registry import (
    IdentityRegistry,
    record_login_failure,
    record_login_success,
)
from .job_queue import drain_jobs_for, signal_switch_done
from .login import auto_login, is_logged_in, refresh_status
from .migration import migrate_legacy_profile_layout
from .profile_manager import ProfileManager
from .rfb import RFBConnectFailed


def _install_signal_handlers() -> None:
    def _on_term(signum: int, _frame: Any) -> None:
        state.log(f"received signal {signum}; exiting cleanly so Camoufox can close Firefox")
        sys.exit(0)
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)


def main() -> None:
    os.makedirs(PROFILE_DIR, exist_ok=True)

    state.log("starting figma-designer-bot (multi-profile v0.3)")
    state.log(f"PROFILES_ROOT={PROFILES_ROOT} IDENTITIES_PATH={IDENTITIES_PATH}")

    _install_signal_handlers()

    state.set_identities(IdentityRegistry())

    migrate_legacy_profile_layout()  # added in T6

    t = threading.Thread(target=run_control_server, daemon=True)
    t.start()

    pm: ProfileManager | None = None
    next_backup = time.time() + 60
    next_refresh = time.time() + REFRESH_SECONDS

    # BLO-6870 cold-bootstrap fix:
    #
    # The /lease/acquire HTTP handler pushes a _SwitchSentinel onto
    # state.job_queue and waits 60s on a threading.Event. The main loop
    # is the only consumer of the queue (via drain_jobs_for), but that
    # drain only fires after `pm` is built — and pm is only built after
    # _active_target is set, which is only set by the queue drain. Cold
    # boots therefore deadlock until the 60s timeout fires "switch_timeout"
    # on every first acquire (escalating backoff 60s → 300s → 1800s).
    #
    # Break the chicken-and-egg by setting _active_target to the default
    # identity BEFORE entering the loop. The first iteration then has
    # target = default, builds pm, launches Camoufox, and from then on
    # drain_jobs_for handles _SwitchSentinels normally.
    default = (
        state.identities.default_identity() if state.identities is not None else None
    )
    if default is not None:
        state.set_active_target(default, force_refresh=False)
        state.log(f"cold-boot: bootstrapped with default identity {default}")

    while True:
        target, force_refresh = state.get_active_target()
        if target is None:
            time.sleep(JOB_POLL_INTERVAL)
            continue

        if pm is None or pm.identity != target or force_refresh:
            if pm is not None:
                pm.close()
                pm = None
            try:
                pm = ProfileManager(target)
                pm.launch()
            except Exception as e:
                state.log(
                    f"main: ProfileManager build for {target} failed: "
                    f"{type(e).__name__}: {str(e)[:160]}"
                )
                record_login_failure(target, f"launch_error:{type(e).__name__}")
                signal_switch_done(
                    target, switched=False, login_performed=False,
                    error=f"launch_error:{type(e).__name__}",
                )
                state.set_active_target(None, False)
                pm = None
                time.sleep(JOB_POLL_INTERVAL)
                continue
            if force_refresh:
                state.clear_force_refresh()

            li, reason = is_logged_in(pm.page)
            login_performed = False
            if not li:
                login_performed = True
                try:
                    auto_login(pm)  # added in T5
                    li, reason = is_logged_in(pm.page)
                except RFBConnectFailed:
                    li, reason = False, "rfb_unreachable"
                except Exception as e:
                    li, reason = False, f"login_error:{type(e).__name__}"
            if li:
                record_login_success(pm.identity)
                with state.status_lock:
                    if login_performed:
                        state.status["session_restored_at"] = time.time()
                    state.status["logged_in"] = True
                    state.status["active_identity"] = pm.identity
                signal_switch_done(
                    pm.identity, switched=True,
                    login_performed=login_performed, error=None,
                )
            else:
                record_login_failure(pm.identity, reason)
                with state.status_lock:
                    state.status["logged_in"] = False
                    state.status["active_identity"] = pm.identity
                signal_switch_done(
                    pm.identity, switched=True,
                    login_performed=login_performed, error=reason,
                )
                pm.close()
                pm = None
                state.set_active_target(None, False)
                time.sleep(JOB_POLL_INTERVAL)
                continue

        drain_jobs_for(pm.page, JOB_POLL_INTERVAL)
        now = time.time()
        if now >= next_refresh:
            try:
                refresh_status(pm.page)
            except Exception as e:
                state.log(f"refresh loop error: {type(e).__name__}: {str(e)[:160]}")
            next_refresh = now + REFRESH_SECONDS
        if now >= next_backup:
            pm.backup_cookies()
            next_backup = now + 300


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        state.log("FATAL: " + type(e).__name__ + ": " + str(e))
        sys.exit(1)
