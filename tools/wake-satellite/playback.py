# tools/wake-satellite/playback.py
"""Audio-Ausgabe über AirPlay-HomePod (+ Fallback auf Standardausgabe).

`SwitchAudioSource` (brew) schaltet das Ausgabegerät, `afplay` spielt. Jeder
Fehler fällt still auf die aktuelle Ausgabe zurück und wirft NIE nach aussen —
eine missglückte Sprachausgabe darf den Satelliten nicht abschiessen."""
import subprocess
import traceback

SWITCH_BIN = "SwitchAudioSource"
AFPLAY_BIN = "afplay"


def _run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True)


def _current_output():
    try:
        return _run([SWITCH_BIN, "-c"]).stdout.strip()
    except Exception:  # noqa: BLE001
        return None


def play(path, device="Homepod Studio"):
    previous = _current_output()
    switched = False
    try:
        _run([SWITCH_BIN, "-s", device])
        switched = True
        _run([AFPLAY_BIN, path])
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        try:
            _run([AFPLAY_BIN, path])       # Fallback: aktuelle Ausgabe
        except Exception:  # noqa: BLE001
            traceback.print_exc()
    finally:
        if switched and previous:
            try:
                _run([SWITCH_BIN, "-s", previous])
            except Exception:  # noqa: BLE001
                traceback.print_exc()
