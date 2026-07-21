"""Sprachnachricht -> deutscher Text via ffmpeg + whisper.cpp (on-demand)."""
import os
import shutil
import subprocess
import tempfile

_HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"]


class TranscriptionError(Exception):
    pass


def _resolve_binary(name):
    found = shutil.which(name)
    if found:
        return found
    for d in _HOMEBREW_DIRS:
        candidate = os.path.join(d, name)
        if os.path.exists(candidate):
            return candidate
    raise TranscriptionError(f"{name} not found on PATH or in Homebrew locations")


def transcribe(ogg_path, model, workdir=None):
    workdir = workdir or tempfile.mkdtemp()
    wav = os.path.join(workdir, "audio.wav")
    prefix = os.path.join(workdir, "transcript")
    ffmpeg_bin = _resolve_binary("ffmpeg")
    whisper_bin = _resolve_binary("whisper-cli")
    try:
        subprocess.run(
            [ffmpeg_bin, "-y", "-i", ogg_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
            check=True, capture_output=True,
        )
        subprocess.run(
            [whisper_bin, "-m", model, "-l", "de", "-nt", "-np",
             "-otxt", "-of", prefix, "-f", wav],
            check=True, capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise TranscriptionError(str(exc)) from exc

    txt_path = prefix + ".txt"
    try:
        if not os.path.exists(txt_path):
            raise TranscriptionError("whisper produced no output")
        with open(txt_path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except TranscriptionError:
        raise
    except Exception as exc:
        raise TranscriptionError(f"failed to read transcript: {exc}") from exc
