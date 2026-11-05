#!/usr/bin/env python3
"""Read-only Git comparison for the native-ingestion delivery branches."""
import argparse
import hashlib
import json
import re
import subprocess

CI_BASE = "8ab89f41e499032e3e55d261f457a3463d754a1d"

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--frozen", required=True)
parser.add_argument("--delivery", required=True)
parser.add_argument("--ci-base", default=CI_BASE,
                    help="Immutable commit whose CI helpers and two test scripts must match (default: %(default)s)")
args = parser.parse_args()
for ref in [args.frozen, args.delivery, args.ci_base]:
    if not re.fullmatch(r"[a-f0-9]{40}", ref):
        parser.error("Use immutable full commit IDs")

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

delivery_package = json.loads(git("show", args.delivery + ":package.json"))

def ci_helper_differences(base):
    approved_package = json.loads(git("show", base + ":package.json"))
    differences = ["package.json:scripts." + key for key in sorted(SCRIPT_EXCEPTIONS)
                   if delivery_package["scripts"][key] != approved_package["scripts"][key]]
    for path in ["scripts/typecheck-low-memory.mjs", "scripts/typecheck-test-projects.mjs", *sorted(CI_ONLY_SERVER_FILES)]:
        if git("show", args.delivery + ":" + path) != git("show", base + ":" + path):
            differences.append(path)
    return differences

differences = ci_helper_differences(args.ci_base)
assert not differences, ("ciHelpers", args.ci_base, differences)
output["ciBase"] = args.ci_base
output["realCiHelpersMatchSelectedBase"] = True
historical_differences = differences if args.ci_base == CI_BASE else ci_helper_differences(CI_BASE)
output["realCiHelpersMatchApproved8ab"] = not historical_differences
output["ciHelperDifferencesFromApproved8ab"] = historical_differences
output["allChangedPaths"] = git("diff", "--name-only", args.frozen, args.delivery).decode().splitlines()
print(json.dumps(output, indent=2))
