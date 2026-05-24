"""Camoufox + Page lifecycle for one identity at a time.

Single instance per running bot. Switching identity = `close()` + new
ProfileManager. Main-thread-only: `launch()` and `close()` touch the
Playwright sync_api which is main-thread-bound.
"""

from __future__ import annotations

import os
import shutil
import threading
from typing import TYPE_CHECKING

from . import state
from .config import PROFILES_ROOT, PROXY_URL
from .identity_registry import slug_for

if TYPE_CHECKING:
    from playwright.sync_api import Page


class ProfileManager:
    """Owns Camoufox + Page lifecycle for ONE identity.

    HTTP handlers use job_queue.submit_job / submit_switch_job to route
    Page calls onto the main thread.
    """

    USER_JS = (
        'user_pref("browser.link.open_newwindow", 1);\n'
        'user_pref("browser.link.open_newwindow.restriction", 0);\n'
        'user_pref("dom.disable_open_during_load", false);\n'
        'user_pref("dom.popup_maximum", 0);\n'
    )
    COOKIE_FILES = ("cookies.sqlite", "storage.sqlite")

    def __init__(self, identity: str):
        self.identity = identity
        self.slug = slug_for(identity)
        self.profile_dir = os.path.join(PROFILES_ROOT, self.slug, "playwright-profile")
        self.backup_dir = os.path.join(PROFILES_ROOT, self.slug, "playwright-profile-backup")
        self.email_file = os.path.join(PROFILES_ROOT, self.slug, "email.txt")
        self._ctx = None
        self._context = None
        self.page: Page | None = None
        self.switch_lock = threading.Lock()
        os.makedirs(os.path.dirname(self.profile_dir), exist_ok=True)
        os.makedirs(self.profile_dir, exist_ok=True)
        os.makedirs(self.backup_dir, exist_ok=True)
        if not os.path.exists(self.email_file):
            with open(self.email_file, "w") as f:
                f.write(self.identity + "\n")
        self._restore_cookies()
        self._write_user_js()

    def _write_user_js(self) -> None:
        try:
            with open(os.path.join(self.profile_dir, "user.js"), "w") as f:
                f.write(self.USER_JS)
        except OSError as e:
            state.log(f"ProfileManager[{self.identity}]: user.js write failed: {e}")

    def _restore_cookies(self) -> None:
        for name in self.COOKIE_FILES:
            live = os.path.join(self.profile_dir, name)
            bak = os.path.join(self.backup_dir, name)
            try:
                live_sz = os.path.getsize(live) if os.path.exists(live) else 0
                bak_sz = os.path.getsize(bak) if os.path.exists(bak) else 0
                if bak_sz > 0 and bak_sz > live_sz:
                    shutil.copy(bak, live)
                    state.log(
                        f"ProfileManager[{self.identity}]: restored {name} "
                        f"bak={bak_sz} > live={live_sz}"
                    )
            except OSError as e:
                state.log(f"ProfileManager[{self.identity}]: restore {name} failed: {e}")

    def backup_cookies(self) -> None:
        """Best-effort backup tick. Skips if switch_lock is held by close()."""
        if not self.switch_lock.acquire(blocking=False):
            return
        try:
            self._backup_locked()
        finally:
            self.switch_lock.release()

    def _backup_locked(self) -> None:
        for name in self.COOKIE_FILES:
            live = os.path.join(self.profile_dir, name)
            if not os.path.exists(live):
                continue
            bak = os.path.join(self.backup_dir, name)
            try:
                shutil.copy(live, bak)
            except OSError as e:
                state.log(f"ProfileManager[{self.identity}]: backup {name} failed: {e}")

    def launch(self) -> None:
        # Lazy-import camoufox so this module is importable in unit-test
        # CI that doesn't install the Camoufox runtime stack.
        from camoufox.sync_api import Camoufox  # noqa: PLC0415

        proxy_kw: dict = {}
        if PROXY_URL:
            proxy_kw["proxy"] = {"server": PROXY_URL}
        self._ctx = Camoufox(
            persistent_context=True,
            user_data_dir=self.profile_dir,
            headless=False,
            **proxy_kw,
        )
        self._context = self._ctx.__enter__()
        try:
            pages = self._context.pages
            self.page = pages[0] if pages else self._context.new_page()
        except Exception:
            try:
                self._ctx.__exit__(None, None, None)
            except Exception as e:
                state.log(
                    f"ProfileManager[{self.identity}]: cleanup after launch error failed: {e}"
                )
            self._ctx = None
            self._context = None
            self.page = None
            raise
        state.log(f"ProfileManager[{self.identity}]: Camoufox launched, slug={self.slug}")

    def close(self) -> None:
        with self.switch_lock:
            try:
                self._backup_locked()
            except Exception as e:
                state.log(f"ProfileManager[{self.identity}]: final backup failed: {e}")
            try:
                if self._ctx is not None:
                    self._ctx.__exit__(None, None, None)
            except Exception as e:
                state.log(f"ProfileManager[{self.identity}]: Camoufox exit failed: {e}")
            self._ctx = None
            self._context = None
            self.page = None
            state.log(f"ProfileManager[{self.identity}]: closed")
