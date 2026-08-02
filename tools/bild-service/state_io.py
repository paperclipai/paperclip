"""Atomic state file I/O — shared between job_state and cost_state."""
import json
import os
import tempfile


def load(path):
    """Load state from path, return {} on missing or corrupt file."""
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save(path, state):
    """Atomically write state to path via temp file + rename."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)
