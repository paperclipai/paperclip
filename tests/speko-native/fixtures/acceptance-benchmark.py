"""Explicit live-acceptance workload: compute for 65 seconds, then read the fixture.

Copy into the disposable agent workspace. Uses one CPU core and no network.
This runs inside the real selected agent; it does not replace the execution adapter.
"""
import hashlib
import json
from pathlib import Path
import time

started = time.monotonic()
iterations = 0
value = b"paperclip-speko-acceptance"
while time.monotonic() - started < 65:
    for _ in range(1024):
        value = hashlib.sha256(value).digest()
    iterations += 1024
print(json.dumps({
    "elapsedSeconds": time.monotonic() - started,
    "iterations": iterations,
    "digest": value.hex(),
    "fixture": Path("ACCEPTANCE.txt").read_text().strip(),
}), flush=True)
