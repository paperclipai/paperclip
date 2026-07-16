"""Continuous X11 frame capture for Paperclip's virtual-headful Camoufox.

Camoufox intentionally starts Xvfb with a 1x1 screen because Playwright can
still render pages into an off-screen viewport. That is sufficient for
action-triggered screenshots, but it makes OS-level live capture useless. The
managed launcher expands only the virtual display surface to match the browser
viewport, then ffmpeg publishes atomic JPEG frames for Paperclip's existing SSE
stream.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


CAPTURE_WIDTH = 1280
CAPTURE_HEIGHT = 720


def configure_virtual_display() -> None:
    """Give Camoufox's Xvfb enough pixels for live viewport capture."""

    try:
        from camoufox.virtdisplay import VirtualDisplay
    except Exception:
        return

    args = list(VirtualDisplay.xvfb_args)
    try:
        screen_index = args.index("-screen")
        args[screen_index + 2] = f"{CAPTURE_WIDTH}x{CAPTURE_HEIGHT}x24"
    except (ValueError, IndexError):
        return
    VirtualDisplay.xvfb_args = tuple(args)


class ContinuousCapture:
    def __init__(self, process: subprocess.Popen[Any]) -> None:
        self.process = process

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)


def _capture_fps() -> float:
    try:
        requested = float(os.environ.get("PAPERCLIP_BROWSER_CAPTURE_FPS", "2"))
    except ValueError:
        requested = 2
    return max(1, min(requested, 5))


def start_continuous_capture(frame_path: Path) -> ContinuousCapture | None:
    """Start atomic JPEG publication from the current Camoufox X display."""

    ffmpeg = shutil.which("ffmpeg")
    display = os.environ.get("DISPLAY", "").strip()
    if not ffmpeg or not display:
        return None

    frame_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "x11grab",
        "-framerate",
        str(_capture_fps()),
        "-video_size",
        f"{CAPTURE_WIDTH}x{CAPTURE_HEIGHT}",
        "-i",
        f"{display}.0",
        "-c:v",
        "mjpeg",
        "-q:v",
        "5",
        "-update",
        "1",
        "-atomic_writing",
        "1",
        "-y",
        str(frame_path),
    ]
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            umask=0o177,
        )
    except (OSError, ValueError):
        return None
    return ContinuousCapture(process)
