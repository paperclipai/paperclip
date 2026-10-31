# Proven Codex staging permission-test consolidation

Historical proof base: #16106 exact head 397459400c6e7b18b462dcac3d8886b390ca8e8c. Original test and production source match exact-head blobs before controls. Isolated snapshot only; serial runs; no shared checkout edits, commits, pushes or PRs.

Historical result: PROVEN. Owner packages/adapters/codex-local/src/server/codex-home.test.ts shrinks 1,412 -> 1,371 lines (41 net removed); registered cases 53 -> 50; three fixture allocations/stageCodexHomeForSync calls and their teardown sequences retired. No subprocess delta or CI-time improvement claimed.

Keeper `stageCodexHomeForSync stages exactly the allowlist, derefs auth.json to bytes, and excludes decoys` gains direct actual 0700 staged-root and 0600 checks for auth.json, config.toml, config.json and instructions.md. Retire the standalone auth mode, every-file mode and directory-mode cases. Same buildFakeHome input bytes/action apply; original runId values differ only in temporary-directory prefix. Keeper retains its run-1 prefix, real allowlist/content/symlink/decoy receipts and cleanup. Dedicated secret-bearing managed-MCP config.toml permission case remains independent.

| Complete-owner phase | Cases | Pass | Fail | Exit |
|---|---:|---:|---:|---:|
| baseline | 53 | 53 | 0 | 0 |
| candidate | 50 | 50 | 0 | 0 |
| file-mode-0644-original | 53 | 50 | 3 | 1 |
| file-mode-0644-keeper | 50 | 48 | 2 | 1 |
| directory-mode-0755-original | 53 | 52 | 1 | 1 |
| directory-mode-0755-keeper | 50 | 49 | 1 | 1 |
| restored-candidate | 50 | 50 | 0 | 0 |
| integrated-stack | 50 | 50 | 0 | 0 |

Every accepted run has zero pending/todo/skipped cases. Both real regressions produce direct intended filesystem-mode assertion failures, not setup, timeouts or worker failures.

## Actual production mutations

- File chmod: in stageCodexHomeEntry's real write path replace explicit fs.chmod(target, 0o600) with 0o644. Actual staged files become group/other readable (420 actual vs 384 expected). Original full owner fails three cases: auth.json mode, managed-MCP config.toml mode, every-file mode. Candidate fails keeper's actual auth.json stat plus the retained managed-MCP case. The duplicate security assertions now live on real staged bytes in keeper.
- Directory chmod: add fs.chmod(stagedHome, 0o755) immediately after mkdtemp and before allowlist copying. Actual staged-root mode becomes 493 vs expected 448. Original dedicated 0700 case and keeper's actual root-stat guard both fail. File bytes/permissions and fixture contents remain otherwise unchanged.

Regressions run one at a time, with full original/candidate owners under identical mutated production bytes. Test/production restores occur in finally and are byte/hash-verified after every pair. Final restored candidate passes 50/50. Source then restores to exact #16106 test and production originals. Fake fixture credentials only; no real Codex home/credentials are accessed, and no production files outside the isolated snapshot are changed.

## Dependencies and isolation

The global pnpm installer differed from the repository's pinned pnpm@9.15.4, stalled before installing the graph, and was explicitly stopped/reaped (exit 143). No tests ran under that installer. Historical setup linked immutable third-party packages from a pnpm store. That private dependency receipt is not bundled. The reproduction below uses a fresh install from the pinned lockfile. Workspace shared and adapter-utils links resolve only to source inside the exact-head isolated snapshot; no application/workspace source is borrowed from the shared checkout. Use existing Codex package Vitest config and full explicit owner path; no mocked resolver/helper or custom alias replaces production code. All controls use the same graph.

## Exact hashes and integrated stack

- Original test SHA256: 8f7a0497cb4d8a0f8de3d341585e74c8c17203ab93fe69d0d78fc59410beb220
- Proven candidate test SHA256: 8615ceaed7c04647bbc2c674448a012d15a6f597eb36c9b2bfbf854baf947cac
- Original/restored production SHA256: fd08bc782af5bdc4631d43cc41f156d97daad629d04fa8654d177f549f8b1b9e

The proven shard, provisioning and Codex test patches all pass git apply --check and apply together without conflict to exact #16106 snapshot. Integrated Codex candidate retains its executed SHA and passes 50/50 with all three patches present. The historical integrated receipt recorded shard test hash `58ecff8ddceecb8e0c44240fa3dbf7ae6a9756dbac35b5ad52a14e655cfc8327`, provisioning test hash `ffacee5de45871dfe9bb2613aa05ffadb452e4c1f7188b8f0519d36d70d935b2`, the Codex candidate hash above, exit 0, 50/50 passing, zero pending/todo and report digest `822a0d3dbf84d01cb6fb62081a7028d77345c4d1526558c920700672fb313dd3`. Afterwards all three tests restore to exact #16106 original bytes. This proves the combined patches apply and Codex owner passes; it does not claim other owners were rerun in the combined state.

## Inspectable reproduction

The results above are historical, recorded on 2026-10-13. This documentation repair
checks the Git source and mutation hashes; it does not claim fresh test results.
Historical raw reports remain local and are not bundled. The relevant failure
excerpts and exact executed production edits are included here; no private proof
file is needed to reconstruct the checks.

Run the block from a repository checkout with the public `base` and `head` Git
revisions below. Fetch those public PR/revisions first if they are absent.
Python 3.12+, Git and Node are required. The UI and Codex recipes also require
pnpm 9.15.4 and network access to install dependencies.

The script uses an isolated snapshot and obtains the candidate test directly
from its Git revision. It runs the full baseline and candidate owners, applies
each mutation independently, checks the intended failing case, restores exact
source bytes in `finally`, and reruns the full candidate. Counts are
`[total, passed, failed, skipped-or-filtered]`. Original-owner mutation counts
above are historical; this recipe repeats candidate sensitivity checks.
Prefix the command with `AUDIT_RECONSTRUCT_ONLY=1` to verify source and mutation
hashes without extracting a snapshot, installing dependencies or running tests.

```sh
python3 - <<'PY'
import hashlib, io, json, os, re, subprocess, tarfile, tempfile
from pathlib import Path

spec = {'base': '397459400c6e7b18b462dcac3d8886b390ca8e8c',
 'head': '449f503f75463956aa0c16cf18623c6217b1f01f',
 'owner': 'packages/adapters/codex-local/src/server/codex-home.test.ts',
 'kind': 'codex',
 'hashes': {'packages/adapters/codex-local/src/server/codex-home.test.ts': '8f7a0497cb4d8a0f8de3d341585e74c8c17203ab93fe69d0d78fc59410beb220',
            'packages/adapters/codex-local/src/server/codex-home.ts': 'fd08bc782af5bdc4631d43cc41f156d97daad629d04fa8654d177f549f8b1b9e'},
 'candidate_hash': '8615ceaed7c04647bbc2c674448a012d15a6f597eb36c9b2bfbf854baf947cac',
 'baseline': [53, 53, 0, 0],
 'candidate': [50, 50, 0, 0],
 'mutations': [{'name': 'directory-mode-0755',
                'path': 'packages/adapters/codex-local/src/server/codex-home.ts',
                'changes': [['  try {\n    for (const entry of CODEX_SYNC_ALLOWLIST) {',
                             '  await fs.chmod(stagedHome, 0o755);\n'
                             '  try {\n'
                             '    for (const entry of CODEX_SYNC_ALLOWLIST) {']],
                'hash': '1b7d02534f024e2f9c4fd6a3bda4604cd3609163e14e3de7dc504847cc1adf5e',
                'counts': [50, 49, 1, 0],
                'guard': 'stageCodexHomeForSync stages exactly the allowlist, derefs auth.json to '
                         'bytes, and excludes decoys',
                'message': 'expected 493 to be 448'},
               {'name': 'file-mode-0644',
                'path': 'packages/adapters/codex-local/src/server/codex-home.ts',
                'changes': [['  await fs.chmod(target, 0o600);\n',
                             '  await fs.chmod(target, 0o644);\n']],
                'hash': '151071d796a14e1bd53a8227d1679f9c30ac73459206fe77481723d151f5118e',
                'counts': [50, 48, 2, 0],
                'guard': 'stageCodexHomeForSync stages exactly the allowlist, derefs auth.json to '
                         'bytes, and excludes decoys',
                'message': 'expected 420 to be 384'}]}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def blob(rev, path):
    return subprocess.check_output(["git", "show", rev + ":" + path])

owner = spec["owner"]
original = {p: blob(spec["base"], p) for p in spec["hashes"]}
candidate = blob(spec["head"], owner)
assert all(digest(b) == spec["hashes"][p] for p, b in original.items())
assert digest(candidate) == spec["candidate_hash"]
mutants = []
for m in spec["mutations"]:
    text = original[m["path"]].decode()
    for before, after in m["changes"]:
        assert text.count(before) == 1, (m["name"], "ambiguous mutation")
        text = text.replace(before, after)
    data = text.encode()
    assert digest(data) == m["hash"], m["name"]
    mutants.append((m, data))
if os.environ.get("AUDIT_RECONSTRUCT_ONLY") == "1":
    print("Original, candidate and all mutation hashes match historical proof.")
    raise SystemExit(0)

archive = subprocess.check_output(["git", "archive", spec["base"]])
with tempfile.TemporaryDirectory(prefix="paperclip-audit-") as directory:
    root = Path(directory)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(root, filter="data")
    if spec["kind"] != "tap":
        assert subprocess.check_output(["pnpm", "--version"], cwd=root, text=True).strip() == "9.15.4"
        subprocess.run(["pnpm", "install", "--frozen-lockfile"],
                       cwd=root, check=True)

    def run(label, expected, mutation=None):
        report = root / "audit-report.json"
        if report.exists():
            report.unlink()
        if spec["kind"] == "tap":
            command = ["node", "--test", "--test-reporter=tap", owner]
        elif spec["kind"] == "ui":
            command = ["pnpm", "--filter", "@paperclipai/ui",
                       "exec", "vitest", "run", "src/pages/CompanyExport.test.tsx",
                       "--maxWorkers=1", "--reporter=default", "--reporter=json",
                       "--outputFile.json=" + str(report)]
        else:
            command = ["node", "node_modules/vitest/vitest.mjs", "run", "--config",
                       "packages/adapters/codex-local/vitest.config.ts", owner,
                       "--reporter=json", "--outputFile=" + str(report)]
        if mutation and mutation.get("selector"):
            command += ["-t", mutation["selector"]]
        result = subprocess.run(command, cwd=root, capture_output=True, text=True,
                                timeout=180)
        output = result.stdout + result.stderr
        print(label, "exit", result.returncode, output)
        if spec["kind"] == "tap":
            counts = {k: int(v) for k, v in re.findall(
                r"^# (tests|pass|fail|skipped) (\d+)$", output, re.M)}
            actual = [counts[k] for k in ["tests", "pass", "fail", "skipped"]]
            if mutation:
                failures = re.findall(
                    r"^not ok \d+ - (.*?)\n(.*?)(?=^(?:ok|not ok) \d+ - |^1\.\.|\Z)",
                    output, re.M | re.S)
                assert any(name == mutation["guard"] and mutation["message"] in body
                           and "ERR_ASSERTION" in body for name, body in failures), label
        else:
            data = json.loads(report.read_text())
            actual = [data[k] for k in ["numTotalTests", "numPassedTests",
                                       "numFailedTests", "numPendingTests"]]
            if mutation:
                hits = [a for suite in data["testResults"] for a in suite["assertionResults"]
                        if a["status"] == "failed" and mutation["guard"] in a["fullName"]]
                assert any(mutation["message"] in msg for a in hits
                           for msg in a["failureMessages"]), label
                if mutation.get("line"):
                    assert any(f'CompanyExport.test.tsx:{mutation["line"]}:' in msg
                               for a in hits for msg in a["failureMessages"]), label
        assert actual == expected, (label, actual, expected)
        assert result.returncode == (1 if mutation else 0), label

    try:
        run("baseline", spec["baseline"])
        (root / owner).write_bytes(candidate)
        run("candidate", spec["candidate"])
        for m, data in mutants:
            try:
                (root / owner).write_bytes(candidate)
                (root / m["path"]).write_bytes(data)
                run(m["name"] + "-keeper", m["counts"], m)
            finally:
                for path, data in original.items():
                    (root / path).write_bytes(data)
                assert all((root / p).read_bytes() == b for p, b in original.items())
        (root / owner).write_bytes(candidate)
        run("restored-candidate", spec["candidate"])
    finally:
        for path, data in original.items():
            (root / path).write_bytes(data)
        assert all((root / p).read_bytes() == b for p, b in original.items())
PY
```

Recorded intended failure excerpts (fixture path prefixes omitted):

```text
directory-mode-0755-original
stageCodexHomeForSync creates the staged dir with mode 0700
AssertionError: expected 493 to be 448 // Object.is equality
directory-mode-0755-keeper
stageCodexHomeForSync stages exactly the allowlist, derefs auth.json to bytes, and excludes decoys
AssertionError: expected 493 to be 448 // Object.is equality
file-mode-0644-original
stageCodexHomeForSync writes the staged auth.json with mode 0600
AssertionError: expected 420 to be 384 // Object.is equality
stageCodexHomeForSync writes the staged config.toml (managed MCP bearer header) with mode 0600
AssertionError: expected 420 to be 384 // Object.is equality
stageCodexHomeForSync writes every staged regular file with mode 0600
AssertionError: auth.json should be staged 0600: expected 420 to be 384 // Object.is equality
file-mode-0644-keeper
stageCodexHomeForSync stages exactly the allowlist, derefs auth.json to bytes, and excludes decoys
AssertionError: auth.json should be staged 0600: expected 420 to be 384 // Object.is equality
stageCodexHomeForSync writes the staged config.toml (managed MCP bearer header) with mode 0600
AssertionError: expected 420 to be 384 // Object.is equality
```
