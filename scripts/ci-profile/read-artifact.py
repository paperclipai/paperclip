"""Read timing JSON from an untrusted PR artifact without extracting any files."""
import json
import sys
import zipfile

MAX_BYTES = 32 * 1024 * 1024
with zipfile.ZipFile(sys.argv[1]) as archive:
    entries = archive.infolist()
    if len(entries) > 5000 or sum(item.file_size for item in entries) > MAX_BYTES:
        raise ValueError("CI timing artifact exceeds the supported size")
    for item in entries:
        if item.is_dir():
            continue
        if not item.filename.endswith(".ndjson"):
            raise ValueError("CI timing artifact contains an unexpected file")
        with archive.open(item) as stream:
            for line in stream:
                if len(line) > 32 * 1024:
                    raise ValueError("CI timing record exceeds the supported size")
                value = json.loads(line)
                if not isinstance(value, dict):
                    raise ValueError("CI timing record must be an object")
                print(json.dumps(value, separators=(",", ":")))
