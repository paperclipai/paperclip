"""Text -> Sprachnachricht (OGG/Opus) via ElevenLabs (stdlib only)."""
import json
import urllib.error
import urllib.request

import config


class TtsError(Exception):
    pass


def synthesize(text, api_key, dest):
    """Synthetisiert `text` via ElevenLabs und schreibt OGG/Opus nach `dest`.

    Gibt `dest` zurück. Wirft TtsError bei leerem Text, fehlendem Key oder
    jedem HTTP-/Netzwerk-/IO-Fehler (analog transcribe.TranscriptionError).
    """
    text = (text or "").strip()
    if not text:
        raise TtsError("empty text")
    if not api_key:
        raise TtsError("missing ElevenLabs API key")

    body = json.dumps({"text": text, "model_id": config.ELEVEN_MODEL}).encode("utf-8")
    req = urllib.request.Request(
        config.ELEVEN_TTS_URL,
        data=body,
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            audio = resp.read()
    except urllib.error.HTTPError as exc:
        raise TtsError("ElevenLabs HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise TtsError("ElevenLabs request failed: {}".format(exc)) from exc

    if not audio:
        raise TtsError("ElevenLabs returned empty audio")
    try:
        with open(dest, "wb") as out:
            out.write(audio)
    except OSError as exc:
        raise TtsError("failed to write audio: {}".format(exc)) from exc
    return dest
