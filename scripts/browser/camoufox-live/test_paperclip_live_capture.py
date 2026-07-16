from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import paperclip_live_capture


class ContinuousCaptureTests(unittest.TestCase):
    def test_starts_atomic_x11_jpeg_capture_for_current_display(self) -> None:
        process = MagicMock()
        with (
            patch.dict(os.environ, {"DISPLAY": ":101", "PAPERCLIP_BROWSER_CAPTURE_FPS": "2"}, clear=False),
            patch.object(paperclip_live_capture.shutil, "which", return_value="/usr/bin/ffmpeg"),
            patch.object(paperclip_live_capture.subprocess, "Popen", return_value=process) as popen,
        ):
            capture = paperclip_live_capture.start_continuous_capture(Path("/tmp/live/frame.jpg"))

        self.assertIsNotNone(capture)
        command = popen.call_args.args[0]
        self.assertIn("x11grab", command)
        self.assertIn(":101.0", command)
        self.assertIn("1280x720", command)
        self.assertIn("-atomic_writing", command)
        self.assertEqual(popen.call_args.kwargs["umask"], 0o177)

    def test_does_not_start_without_ffmpeg_or_a_display(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(paperclip_live_capture.shutil, "which", return_value=None),
        ):
            self.assertIsNone(
                paperclip_live_capture.start_continuous_capture(Path("/tmp/live/frame.jpg"))
            )

    def test_capture_rate_is_bounded(self) -> None:
        with patch.dict(os.environ, {"PAPERCLIP_BROWSER_CAPTURE_FPS": "99"}, clear=False):
            self.assertEqual(paperclip_live_capture._capture_fps(), 5)
        with patch.dict(os.environ, {"PAPERCLIP_BROWSER_CAPTURE_FPS": "0"}, clear=False):
            self.assertEqual(paperclip_live_capture._capture_fps(), 1)


if __name__ == "__main__":
    unittest.main()
