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
    identity_in_backoff,
    record_login_failure,
    record_login_success,
)
from .job_queue import (
    drain_jobs_for,
    drain_pending_switch_sentinels,
    signal_switch_done,
)
from .login import TransientNetworkError, auto_login, is_logged_in, refresh_status
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
        # Always drain queued switch sentinels first, regardless of pm
        # state. Without this, after an auto_login failure tore pm
        # down, drain_jobs_for (the previous sentinel consumer) could
        # never run, and any /lease/acquire after the first failure
        # would time out at 60s with switch_timeout — the same
        # chicken-and-egg as BLO-6870 but post-failure. See
        # drain_pending_switch_sentinels docstring.
        drain_pending_switch_sentinels()

        target, force_refresh = state.get_active_target()
        if target is None:
            time.sleep(JOB_POLL_INTERVAL)
            continue

        if pm is None or pm.identity != target or force_refresh:
            # Respect the backoff window so we don't hot-loop Camoufox
            # launches while the identity is in cooldown (transient
            # infra flap or escalating auth backoff). When the cooldown
            # clears, we re-enter this branch and try again.
            #
            # Pre-fix, the failure path called set_active_target(None,
            # False), which made the loop sleep on the `target is None`
            # branch — and the only way out was an external rollout
            # restart. Now: target stays set, backoff governs retry
            # cadence, and the bot recovers autonomously when the infra
            # comes back.
            remain = identity_in_backoff(target)
            if remain is not None:
                # Sleep at most JOB_POLL_INTERVAL so we still drain
                # incoming sentinels (e.g. a switch-to-different-
                # identity request) responsively.
                time.sleep(min(remain, JOB_POLL_INTERVAL))
                continue
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
                # launch_error is infrastructure-side (Camoufox crash,
                # disk full, etc.), not credentials — give it the same
                # short cooldown as other transient-infra failures
                # rather than the 60s→6h auth-backoff schedule.
                record_login_failure(
                    target, f"launch_error:{type(e).__name__}",
                    transient_infra=True,
                )
                signal_switch_done(
                    target, switched=False, login_performed=False,
                    error=f"launch_error:{type(e).__name__}",
                )
                # Tear down the partially-launched Camoufox so its subprocess
                # tree is killed + reaped (BLO-8271). The pre-fix path set
                # pm=None WITHOUT close(), leaking <defunct> Firefox children on
                # every launch_error — and those are frequent (infra-side
                # crashes). pm is None only if the ProfileManager ctor itself
                # raised (no browser spawned), so this guard is correct.
                if pm is not None:
                    try:
                        pm.close()
                    except Exception as ce:
                        state.log(
                            f"main: close after launch_error failed: "
                            f"{type(ce).__name__}: {ce}"
                        )
                # DO NOT clear active_target — the next iteration's
                # backoff check will sleep until the cooldown clears,
                # then retry. Pre-fix, set_active_target(None, False)
                # deadlocked subsequent /lease/acquire calls.
                pm = None
                time.sleep(JOB_POLL_INTERVAL)
                continue
            if force_refresh:
                state.clear_force_refresh()

            li, reason = is_logged_in(pm.page)
            login_performed = False
            # Tracks whether the failure (if any) is an infrastructure
            # flap (tailscale exit-node down, x11vnc unreachable, proxy
            # CONNECTION_REFUSED) rather than a credentials/UI problem.
            # Infra flaps get a 30s cooldown; everything else escalates
            # the 60s→6h backoff schedule.
            transient_infra = False
            if not li:
                login_performed = True
                try:
                    auto_login(pm)  # added in T5
                    # Trust auto_login's internal success signal (URL
                    # settled away from /login OR /api/user/profile
                    # returned 200). The immediate re-probe right here
                    # was returning HTTP 400 transiently for ~10-30s
                    # after a successful form-submit login — likely a
                    # CSRF / Origin freshness window — and the bot was
                    # treating that as a hard failure even though
                    # auto_login had already verified the session.
                    # Live observation 2026-05-25 03:58: URL settled
                    # at /files/team/.../recents-and-sharing within
                    # 12s of RFB-click, but the very next is_logged_in
                    # call returned http_400 → bot closed Camoufox and
                    # tore down a valid session. The main loop's
                    # `refresh_status` heartbeat (every REFRESH_SECONDS)
                    # re-probes once the freshness window passes.
                    li, reason = True, ""
                except RFBConnectFailed as e:
                    state.log(f"auto_login[{pm.identity}]: RFBConnectFailed: {e}")
                    li, reason = False, "rfb_unreachable"
                    transient_infra = True  # x11vnc sidecar flap, not auth
                except TransientNetworkError as e:
                    state.log(
                        f"auto_login[{pm.identity}]: transient network: "
                        f"{str(e)[:300]}"
                    )
                    li, reason = False, f"transient_network:{str(e)[:120]}"
                    transient_infra = True  # tailscale/proxy flap, not auth
                except Exception as e:
                    state.log(
                        f"auto_login[{pm.identity}]: {type(e).__name__}: "
                        f"{str(e)[:300]}"
                    )
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
                record_login_failure(
                    pm.identity, reason, transient_infra=transient_infra,
                )
                with state.status_lock:
                    state.status["logged_in"] = False
                    state.status["active_identity"] = pm.identity
                signal_switch_done(
                    pm.identity, switched=True,
                    login_performed=login_performed, error=reason,
                )
                pm.close()
                pm = None
                # DO NOT clear active_target — let the loop retry after
                # the cooldown clears. See the launch_error block above
                # for the full rationale.
                time.sleep(JOB_POLL_INTERVAL)
                continue
        else:
            # Same identity, no refresh requested — the switch is a no-op.
            # The /lease/acquire HTTP handler pushed a _SwitchSentinel that
            # drain_jobs_for already consumed (recording set_active_target).
            # But the rebuild block — where signal_switch_done normally
            # fires — is skipped. Without an explicit signal here, the
            # handler's done Event never sets, and submit_switch_job times
            # out at 60s with "switch_timeout", which ratchets the identity
            # backoff schedule (60s → 300s → 1800s → 7200s → 21600s) on a
            # healthy bot. Signal the no-op so the lease returns immediately.
            #
            # signal_switch_done is idempotent: if there are no pending
            # entries for `target`, it's a no-op. So calling it every loop
            # iteration in steady state is harmless.
            signal_switch_done(
                target, switched=False, login_performed=False, error=None,
            )

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
