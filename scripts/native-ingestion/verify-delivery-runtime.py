#!/usr/bin/env python3
"""Read-only Git comparison for the native-ingestion delivery branches."""
import argparse
import hashlib
import json
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--frozen", required=True)
parser.add_argument("--delivery", required=True)
args = parser.parse_args()
for ref in [args.frozen, args.delivery]:
    if not re.fullmatch(r"[a-f0-9]{40}", ref):
        parser.error("Use immutable full commit IDs")

CI_BASE = "8ab89f41e499032e3e55d261f457a3463d754a1d"
SCRIPT_EXCEPTIONS = {"test:e2e:runner:typecheck", "test:lifecycle-baseline:typecheck"}
CI_ONLY_SERVER_FILES = {"server/scripts/typecheck-layers.mjs"}

def git(*parts):
    return subprocess.check_output(["git", *parts], cwd=args.repo)

def is_runtime(path, expanded=False):
    prefixes = ("server/" if expanded else "server/src/", "packages/", "ui/", "cli/", "skills/")
    return (path.startswith(prefixes)
            and not any(part in ("__tests__", "tests", "test") for part in path.split("/"))
            and not path.endswith((".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".spec.ts", ".spec.tsx", ".spec.js"))
            and path not in CI_ONLY_SERVER_FILES)

def manifest(ref, expanded=False):
    rows = []
    for entry in git("ls-tree", "-r", "-z", ref).split(b"\0"):
        if not entry:
            continue
        metadata, name = entry.split(b"\t", 1)
        path = name.decode()
        if is_runtime(path, expanded):
            rows.append([path, *metadata.decode().split(" ")])
    rows.sort()
    package = json.loads(git("show", ref + ":package.json"))
    content = {"files": rows,
               "rootPackageNonScripts": {key: value for key, value in package.items() if key != "scripts"},
               "rootScriptsExceptTwoTestTypechecks": {key: value for key, value in package["scripts"].items() if key not in SCRIPT_EXCEPTIONS}}
    digest = hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"count": len(rows), "sha256": digest}

output = {"frozen": args.frozen, "delivery": args.delivery, "sourceMutation": False}
for name, expanded in [("approvedScope", False), ("expandedServerBuildInputs", True)]:
    frozen, delivery = manifest(args.frozen, expanded), manifest(args.delivery, expanded)
    assert frozen == delivery, (name, frozen, delivery)
    output[name] = {"equal": True, "frozen": frozen, "delivery": delivery}

approved_package = json.loads(git("show", CI_BASE + ":package.json"))
delivery_package = json.loads(git("show", args.delivery + ":package.json"))
for key in SCRIPT_EXCEPTIONS:
    assert delivery_package["scripts"][key] == approved_package["scripts"][key], key
for path in ["scripts/typecheck-low-memory.mjs", "scripts/typecheck-test-projects.mjs", *CI_ONLY_SERVER_FILES]:
    assert git("show", args.delivery + ":" + path) == git("show", CI_BASE + ":" + path), path
output["realCiHelpersMatchApproved8ab"] = True
output["allChangedPaths"] = git("diff", "--name-only", args.frozen, args.delivery).decode().splitlines()
print(json.dumps(output, indent=2))
