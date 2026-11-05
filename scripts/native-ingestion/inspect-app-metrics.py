#!/usr/bin/env python3
"""Summarize diagnostic app samples, excluding them from performance acceptance."""
import gzip
import json
import pathlib
import sys

if len(sys.argv) != 2:
    raise SystemExit("Pass one .ndjson or .ndjson.gz diagnostic app metrics file")
path = pathlib.Path(sys.argv[1])
raw = gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes()
rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
samples = [row for row in rows if row.get("kind") == "app-sample"]
if not samples:
    raise SystemExit("No app samples found")
print(json.dumps({
    "scope": "Instrumented failed historical local-process baseline replay; no acceptance comparison",
    "sampleCount": len(samples),
    "firstAtMs": samples[0]["atMs"],
    "lastAtMs": samples[-1]["atMs"],
    "sampleSpanMs": samples[-1]["atMs"] - samples[0]["atMs"],
    "maxObservedNormalizedQueueDepth": max(row["actualNormalizedQueueDepth"] for row in samples),
    "maxObservedRssBytes": max(row["rssBytes"] for row in samples),
    "lastSample": samples[-1],
    "limits": [
        "Queue counts the normalized upstream queue, excluding collector/pending-read/in-flight/transport queues",
        "Observed peaks are sample based",
        "Cumulative filesystem elapsed times overlap across async operations and include scheduling; do not sum or interpret async sync elapsed as blocked CPU",
        "Serialization elapsed ends before byte-counting probe; sampled wrapper residence includes byte counting",
        "Diagnostic instrumentation and its observer work are excluded from acceptance",
    ],
}, indent=2))
