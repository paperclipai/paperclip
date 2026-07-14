"""Publish virtual-headful Camoufox frames for Paperclip managed runs.

Python imports ``sitecustomize`` automatically from ``PYTHONPATH``. The
``paperclip-camoufox-python`` launcher adds this directory so ordinary
Camoufox/Playwright scripts become observable without changing their workflow
code. The patch is deliberately inert outside a Paperclip browser scope.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import urllib.request
from functools import wraps
from pathlib import Path
from typing import Any, Callable


_SCOPE = os.environ.get("PAPERCLIP_BROWSER_SCOPE_ID", os.environ.get("PAPERCLIP_RUN_ID", "")).strip()
_PROVIDER = "camoufox"
_MARKED = False
_MARK_LOCK = threading.Lock()
_LATEST_PAGE: Any = None
_LATEST_PAGE_LOCK = threading.Lock()


def _safe(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]", "_", value)[:120] or "default"


def _paths() -> tuple[Path, Path] | None:
    if not _SCOPE:
        return None
    root = Path(os.environ.get("PAPERCLIP_HOME", "/paperclip")) / "browser-artifacts"
    safe_scope = _safe(_SCOPE)
    return root / f"{safe_scope}-provider", root / f"{safe_scope}-camoufox.jpg"


def _atomic_text(path: Path, value: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(value)
    temporary.chmod(0o600)
    temporary.replace(path)


def _mark_activity() -> None:
    global _MARKED
    if _MARKED:
        return
    with _MARK_LOCK:
        if _MARKED:
            return
        selected = _paths()
        if selected is None:
            return
        provider_path, _ = selected
        provider_path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_text(provider_path, f"{_PROVIDER}\n")

        api_url = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
        api_key = os.environ.get("PAPERCLIP_API_KEY", "")
        run_id = os.environ.get("PAPERCLIP_RUN_ID", "")
        if api_url and api_key and run_id:
            try:
                request = urllib.request.Request(
                    f"{api_url}/api/heartbeat-runs/{run_id}/browser-activity",
                    data=b"",
                    method="POST",
                    headers={"Authorization": f"Bearer {api_key}", "X-Paperclip-Run-Id": run_id},
                )
                urllib.request.urlopen(request, timeout=3).close()
            except Exception:
                pass
        _MARKED = True


def _remember_page(page: Any) -> Any:
    global _LATEST_PAGE
    if page is not None:
        with _LATEST_PAGE_LOCK:
            _LATEST_PAGE = page
    return page


def _fallback_page() -> Any:
    with _LATEST_PAGE_LOCK:
        return _LATEST_PAGE


def _page_from_locator(locator: Any) -> Any:
    try:
        from playwright._impl._impl_to_api_mapping import mapping

        return mapping.from_impl(locator._impl_obj._frame._page)
    except Exception:
        return _fallback_page()


def _publish_sync(page: Any) -> None:
    selected = _paths()
    if selected is None or page is None:
        return
    _mark_activity()
    _remember_page(page)
    _, frame_path = selected
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = frame_path.with_name(
        f".{frame_path.name}.{os.getpid()}.{threading.get_ident()}.tmp.jpg"
    )
    try:
        page.screenshot(path=str(temporary), type="jpeg", quality=78, full_page=False, timeout=5_000)
        temporary.chmod(0o600)
        temporary.replace(frame_path)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass


async def _publish_async(page: Any) -> None:
    selected = _paths()
    if selected is None or page is None:
        return
    _mark_activity()
    _remember_page(page)
    _, frame_path = selected
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = frame_path.with_name(
        f".{frame_path.name}.{os.getpid()}.{threading.get_ident()}.tmp.jpg"
    )
    try:
        await page.screenshot(path=str(temporary), type="jpeg", quality=78, full_page=False, timeout=5_000)
        temporary.chmod(0o600)
        temporary.replace(frame_path)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except Exception:
            pass


def _patch_sync_method(cls: Any, name: str, page_getter: Callable[[Any], Any]) -> None:
    original = getattr(cls, name, None)
    if original is None or getattr(original, "_paperclip_live_patched", False):
        return

    @wraps(original)
    def wrapped(self: Any, *args: Any, **kwargs: Any) -> Any:
        result = original(self, *args, **kwargs)
        _publish_sync(page_getter(self))
        return result

    wrapped._paperclip_live_patched = True  # type: ignore[attr-defined]
    setattr(cls, name, wrapped)


def _patch_async_method(cls: Any, name: str, page_getter: Callable[[Any], Any]) -> None:
    original = getattr(cls, name, None)
    if original is None or getattr(original, "_paperclip_live_patched", False):
        return

    @wraps(original)
    async def wrapped(self: Any, *args: Any, **kwargs: Any) -> Any:
        result = await original(self, *args, **kwargs)
        await _publish_async(page_getter(self))
        return result

    wrapped._paperclip_live_patched = True  # type: ignore[attr-defined]
    setattr(cls, name, wrapped)


def _install_sync_patches() -> None:
    from playwright.sync_api import Keyboard, Locator, Mouse, Page

    page_actions = (
        "goto", "reload", "go_back", "go_forward", "click", "dblclick", "fill", "type",
        "press", "check", "uncheck", "select_option", "hover", "focus", "drag_and_drop",
        "set_input_files", "wait_for_timeout", "bring_to_front",
    )
    locator_actions = (
        "click", "dblclick", "fill", "type", "press", "check", "uncheck", "select_option",
        "hover", "focus", "drag_to", "set_input_files",
    )
    keyboard_actions = ("type", "press", "insert_text")
    mouse_actions = ("click", "dblclick", "move", "down", "up", "wheel")
    for name in page_actions:
        _patch_sync_method(Page, name, lambda page: page)
    for name in locator_actions:
        _patch_sync_method(Locator, name, _page_from_locator)
    for name in keyboard_actions:
        _patch_sync_method(Keyboard, name, lambda _: _fallback_page())
    for name in mouse_actions:
        _patch_sync_method(Mouse, name, lambda _: _fallback_page())


def _install_async_patches() -> None:
    from playwright.async_api import Keyboard, Locator, Mouse, Page

    page_actions = (
        "goto", "reload", "go_back", "go_forward", "click", "dblclick", "fill", "type",
        "press", "check", "uncheck", "select_option", "hover", "focus", "drag_and_drop",
        "set_input_files", "wait_for_timeout", "bring_to_front",
    )
    locator_actions = (
        "click", "dblclick", "fill", "type", "press", "check", "uncheck", "select_option",
        "hover", "focus", "drag_to", "set_input_files",
    )
    keyboard_actions = ("type", "press", "insert_text")
    mouse_actions = ("click", "dblclick", "move", "down", "up", "wheel")
    for name in page_actions:
        _patch_async_method(Page, name, lambda page: page)
    for name in locator_actions:
        _patch_async_method(Locator, name, _page_from_locator)
    for name in keyboard_actions:
        _patch_async_method(Keyboard, name, lambda _: _fallback_page())
    for name in mouse_actions:
        _patch_async_method(Mouse, name, lambda _: _fallback_page())


if _SCOPE and ("camoufox" in sys.executable.lower() or os.environ.get("PAPERCLIP_CAMOUFOX_FORCE_LIVE") == "1"):
    try:
        _install_sync_patches()
        _install_async_patches()
    except Exception as error:
        # Never break the browser workflow because observability failed. Keep a
        # local diagnostic outside the transcript and let Camoufox continue.
        try:
            selected = _paths()
            if selected is not None:
                diagnostic = selected[0].with_name(f"{_safe(_SCOPE)}-camoufox-live-error.json")
                diagnostic.parent.mkdir(parents=True, exist_ok=True)
                _atomic_text(diagnostic, json.dumps({"error": str(error)}) + "\n")
        except Exception:
            pass
