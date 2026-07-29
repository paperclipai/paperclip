# tools/wake-satellite/satellite.py
"""Wake-Word-Satellit „Hey Jarvis": Schleife + Interaktion.

`main` verdrahtet Mikrofon + Wake-Word (Hardware). `handle_interaction` ist die
testbare Interaktion nach einem Wake-Treffer: aufnehmen -> transkribieren ->
Jarvis-Gehirn -> sprechen -> 6-s-Nachfrage-Fenster. Ein Gehirn (jarvis_brain),
geteilt mit dem Telegram-Bot."""
import os
import shutil
import tempfile
import time
import traceback

import config as vco_config          # voice-echo-bot: load_env, ENV_PATH, load_paperclip_token
import jarvis_brain
import transcribe
import tts

import sat_config
import capture
import earcon
import playback
import wake


def _resolve_token(deps):
    tok = deps["token"]
    return tok() if callable(tok) else tok


def _remember(history, user_text, assistant_text):
    hist = list(history)
    hist.append({"role": "user", "content": user_text})
    hist.append({"role": "assistant", "content": assistant_text})
    if len(hist) > sat_config.MAX_HISTORY_MESSAGES:
        del hist[:len(hist) - sat_config.MAX_HISTORY_MESSAGES]
    return hist


def _transcribe(recorded, deps):
    workdir = tempfile.mkdtemp()
    wav = capture.frames_to_wav(recorded, os.path.join(workdir, "utt.wav"))
    try:
        return transcribe.transcribe(wav, deps["whisper_model"])
    except transcribe.TranscriptionError:
        traceback.print_exc()
        return ""
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _speak(text, deps):
    if not (text or "").strip():
        return
    workdir = tempfile.mkdtemp()
    dest = os.path.join(workdir, "reply.mp3")
    try:
        try:
            tts.synthesize(text, deps["eleven_key"], dest, output_format=sat_config.TTS_FORMAT)
        except tts.TtsError:
            traceback.print_exc()
            return
        playback.play(dest, device=sat_config.HOMEPOD_DEVICE)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def handle_interaction(frames, deps, tenant=None, history=None):
    tenant = tenant or sat_config.TENANT
    history = list(history or [])
    flush_mic = deps.get("flush_mic")
    # Sobald eine Runde dieser Kette eine Vault-Antwort geliefert hat, landet
    # der Fund im Gesprächsverlauf (`history`) — die Websuche wird für den
    # Rest der Kette gesperrt, damit private Daten nicht per WEB: nach draußen
    # wandern. Rein lokaler Merker: `main()` startet jede Kette ohne History,
    # die Sperre wirkt also nie über ein erneutes "Hey Jarvis" hinaus.
    web_locked_after_lookup = False
    for turn in range(sat_config.MAX_TURNS_PER_WAKE):
        recorded = capture.record_until_silence(frames)
        if not recorded:
            break
        t0 = time.monotonic()
        text = _transcribe(recorded, deps)
        t1 = time.monotonic()
        web_key = None if web_locked_after_lookup else deps.get("web_key")
        result = jarvis_brain.respond(text, tenant, _resolve_token(deps),
                                      deps["chat_model"], history=history,
                                      source="per Sprache", voice_output=True,
                                      web_key=web_key)
        t2 = time.monotonic()
        if result["kind"] == "lookup":
            web_locked_after_lookup = True
        answer = result["answer"]
        if result["kind"] in ("chat", "lookup", "issue", "web"):
            history = _remember(history, text, answer)
        _speak(answer, deps)
        if flush_mic:
            flush_mic()      # eigene Wiedergabe nicht als Nachfrage hören
        t3 = time.monotonic()
        print("[timing] runde={}/{} aufnahme={:.1f}s stt={:.1f}s llm({})={:.1f}s "
              "tts+play={:.1f}s | text='{}'".format(
                  turn + 1, sat_config.MAX_TURNS_PER_WAKE,
                  len(recorded) * sat_config.FRAME_SAMPLES / sat_config.SAMPLE_RATE,
                  t1 - t0, result["kind"], t2 - t1, t3 - t2, (text or "")[:50]),
              flush=True)
        if not capture.wait_for_speech(frames, window_frames=sat_config.FOLLOWUP_WINDOW_FRAMES,
                                       min_run=sat_config.FOLLOWUP_MIN_SPEECH_FRAMES):
            break
    return history


def build_deps():
    env = vco_config.load_env(vco_config.ENV_PATH)
    detector = wake.WakeDetector(sat_config.WAKE_MODELS, threshold=sat_config.WAKE_THRESHOLD,
                                 inference_framework=sat_config.INFERENCE_FRAMEWORK,
                                 required_hits=sat_config.WAKE_REQUIRED_HITS)
    return {
        "detector": detector,
        "whisper_model": os.path.expanduser(env["WHISPER_MODEL"]),
        "eleven_key": env.get("ELEVENLABS_API_KEY"),
        "chat_model": sat_config.CHAT_MODEL or env.get("CHAT_MODEL") or jarvis_brain.llm.DEFAULT_MODEL,
        "token": vco_config.load_paperclip_token,
        "web_key": env.get("TAVILY_API_KEY"),
    }


def main():  # pragma: no cover — Hardware
    import sys
    import itertools
    from collections import deque
    print("wake-satellit „Hey Jarvis“ startet…", file=sys.stderr)
    deps = build_deps()
    detector = deps["detector"]
    mic = capture.MicStream()
    deps["flush_mic"] = mic.flush
    frames = iter(mic)
    preroll = deque(maxlen=sat_config.PREROLL_FRAMES)
    while True:
        try:
            frame = next(frames)
            preroll.append(frame)
            hit = detector.process(frame)
            if hit is None:
                continue
            print("[wake] {} score={:.2f}".format(*hit), flush=True)
            earcon.beep_async()                # blockiert nicht -> kein Clipping
            pre = list(preroll)                # ~1,2 s vor dem Treffer voranstellen
            preroll.clear()
            handle_interaction(itertools.chain(pre, frames), deps)
            detector.reset()
            time.sleep(sat_config.PLAYBACK_COOLDOWN_SEC)
            mic.flush()          # Rückstau nicht in den Wake-Detektor spülen
            preroll.clear()
        except Exception:  # noqa: BLE001
            traceback.print_exc()
            time.sleep(1)


if __name__ == "__main__":
    main()
