"""Sprachnachricht -> deutscher Text via ffmpeg + whisper.cpp (on-demand)."""
import os
import subprocess
import tempfile


class TranscriptionError(Exception):
    pass


def transcribe(ogg_path, model, workdir=None):
    workdir = workdir or tempfile.mkdtemp()
    wav = os.path.join(workdir, "audio.wav")
    prefix = os.path.join(workdir, "transcript")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", ogg_path, "-ar", "16000", "-ac", "1", "-f", "wav", wav],
            check=True, capture_output=True,
        )
        subprocess.run(
            ["whisper-cli", "-m", model, "-l", "de", "-nt", "-np",
             "-otxt", "-of", prefix, "-f", wav],
            check=True, capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise TranscriptionError(str(exc)) from exc

    txt_path = prefix + ".txt"
    if not os.path.exists(txt_path):
        raise TranscriptionError("whisper produced no output")
    with open(txt_path, "r", encoding="utf-8") as fh:
        return fh.read().strip()
