#!/usr/bin/env python3
"""Describe sealed V8 profiles; sampled stack time is not process CPU usage."""
import collections
import gzip
import hashlib
import json
import pathlib
import sys

if len(sys.argv) < 2:
    raise SystemExit("Pass one or more .cpuprofile or .cpuprofile.gz paths")

reports = []
for argument in sys.argv[1:]:
    path = pathlib.Path(argument)
    raw = path.read_bytes()
    if path.suffix == ".gz":
        raw = gzip.decompress(raw)
    profile = json.loads(raw)
    nodes = {node["id"]: node for node in profile["nodes"]}
    parents = {child: node["id"] for node in nodes.values() for child in node.get("children", [])}
    assert len(profile["samples"]) == len(profile["timeDeltas"])
    own, inclusive = collections.Counter(), collections.Counter()

    def frame(node_id):
        value = nodes[node_id]["callFrame"]
        return (value["functionName"] or "<anonymous>", value["url"], value["lineNumber"] + 1)

    for node_id, duration in zip(profile["samples"], profile["timeDeltas"]):
        assert duration >= 0
        own[frame(node_id)] += duration
        seen = set()
        while node_id in nodes:
            key = frame(node_id)
            if key not in seen:
                inclusive[key] += duration
                seen.add(key)
            if node_id not in parents:
                break
            node_id = parents[node_id]
    total = sum(profile["timeDeltas"])
    assert total > 0

    def ranked(counter, limit):
        return [{"function": key[0], "url": key[1], "line": key[2],
                 "weightedMillis": duration / 1000, "sampledSharePercent": duration * 100 / total}
                for key, duration in counter.most_common(limit)]

    application = collections.Counter({key: value for key, value in inclusive.items()
                                       if key[1].startswith("file:") and key[0] != "<anonymous>"})
    reports.append({"file": path.name.removesuffix(".gz"), "decompressedSha256": hashlib.sha256(raw).hexdigest(),
                    "samples": len(profile["samples"]), "weightedMillis": total / 1000,
                    "self": ranked(own, 20), "inclusiveFileFrames": ranked(application, 30)})

print(json.dumps({"scope": "Diagnostic only; no performance acceptance claim",
                  "method": "Weight each sampled frame by its corresponding V8 timeDelta; inclusive frames deduplicate recursion",
                  "limits": ["Includes idle and native blocking time; this is not process CPU usage",
                             "Inclusive frames overlap and must not be summed",
                             "Instrumented wrapper residence can include byte counting or other probe work",
                             "Instrumentation and failed-run phases must remain identified"],
                  "profiles": reports}, indent=2))
