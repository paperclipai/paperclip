import os
import tempfile
import unittest
from unittest import mock

import transcribe


class TestTranscribe(unittest.TestCase):
    def test_runs_ffmpeg_then_whisper_and_returns_text(self):
        workdir = tempfile.mkdtemp()
        ogg = os.path.join(workdir, "in.oga")
        open(ogg, "wb").close()

        def fake_run(cmd, **kwargs):
            if cmd[0] == "whisper-cli":
                # -of <prefix> steht direkt vor -f <wav>; schreibe <prefix>.txt
                prefix = cmd[cmd.index("-of") + 1]
                with open(prefix + ".txt", "w", encoding="utf-8") as fh:
                    fh.write("  Kaufe Milch und rufe den Steuerberater an.  \n")
            return mock.MagicMock(returncode=0)

        with mock.patch("transcribe.subprocess.run", side_effect=fake_run):
            text = transcribe.transcribe(ogg, "model.bin", workdir=workdir)
        self.assertEqual(text, "Kaufe Milch und rufe den Steuerberater an.")

    def test_raises_on_ffmpeg_failure(self):
        workdir = tempfile.mkdtemp()
        ogg = os.path.join(workdir, "in.oga")
        open(ogg, "wb").close()
        import subprocess

        def boom(cmd, **kwargs):
            raise subprocess.CalledProcessError(1, cmd)

        with mock.patch("transcribe.subprocess.run", side_effect=boom):
            with self.assertRaises(transcribe.TranscriptionError):
                transcribe.transcribe(ogg, "model.bin", workdir=workdir)


if __name__ == "__main__":
    unittest.main()
