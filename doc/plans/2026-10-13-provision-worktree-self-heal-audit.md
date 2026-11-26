# Proven provisioning test consolidation

Historical proof base: #16106 exact head 397459400c6e7b18b462dcac3d8886b390ca8e8c, extracted into an isolated temporary snapshot. All test and production owners match exact-head Git blobs. Disjoint shard candidate reverted before this sequence. All runs serial; no shared checkout edits, commits, pushes or PR actions.

Historical result: PROVEN with one preserved existing tool-availability skip. Owner scripts/__tests__/provision-worktree-self-heal.test.mjs shrinks 717 -> 707 lines (10 net); registered cases 35 -> 34; one repeated top-level bash runProvision launch retired. Nested subprocess savings unquantified. No CI-time claim.

Retire `falls back to an isolated config when the base CLI cannot boot`. Keeper `reconciles deployment mode from the registered source when reusing a guest config` is renamed `isolates fallback configuration and reconciles deployment mode from the registered source when reusing a guest config`.

Both originals allocate makeBaseWorkspace({helpExit:1, initExit:0}) and call runProvision(baseCwd) with identical defaults. Move all fallback stderr, persisted config source, real database-path containment, actual .env and pending seed-manifest assertions into keeper immediately after first successful launch and before changing source config. Only lexical result.stderr -> first.stderr changes. Retain original local_trusted, second real bash launch and config reuse/reconciliation receipts.

| Complete-owner phase | Cases | Pass | Fail | Skip | Exit |
|---|---:|---:|---:|---:|---:|
| baseline | 35 | 34 | 0 | 1 | 0 |
| candidate | 34 | 33 | 0 | 1 | 0 |
| database-path-escape-original | 35 | 32 | 2 | 1 | 1 |
| database-path-escape-keeper | 34 | 32 | 1 | 1 | 1 |
| restored-candidate | 34 | 33 | 0 | 1 | 0 |

Every accepted run has zero cancelled/todo. Existing skip: ok 20 - repairs an unhealthy base install under the lock and then uses the CLI # SKIP flock or git not available on this host

## Production regression and restoration

Change only generated fallback targetConfig.database.embeddedPostgresDataDir in scripts/provision-worktree.sh from path.resolve(instanceRoot, "db") to path.resolve(worktreeHome, "..", "misdirected-worktree-db"). This writes only a config value; it does not create or touch files at that escaped path. Original and keeper both fail the exact assertion `!path.relative(worktreesHome, dataDir).startsWith("..")`, reporting the actual persisted escaped path before keeper's second launch. No setup/timeout failure qualifies the control.

Original mutated complete owner has two direct failures: exact isolation assertion, plus separate reuse case's unchanged /Reusing existing isolated Paperclip worktree config/ guard when production correctly treats escaped-path config as stale. Candidate mutated complete owner has one failure: relocated exact isolation assertion. The exact mutation and relevant failures are included below. Production bytes restore in finally and hash-check before restored candidate (33 passing/1 unchanged skipped). Test owner restores to exact-head original after proof.

Initial default-sandbox baseline was rejected by real localhost binding EPERM: 35 cases, 32 passing, 2 setup failures, 1 existing skip. No candidate/mutation ran during that attempt. Those local reports are not bundled; these setup failures are not accepted controls. Approved escalation then ran the identical sequence with real localhost binding enabled, producing the accepted table above. No production behavior, assertions, deadlines, retries or skip logic changed.

## Exact executable hashes

- Original test: 29d758d74d32418ea4de53c6cea4409d29c5310252a10d558c19e08ba36a670a
- Proven candidate test: ffacee5de45871dfe9bb2613aa05ffadb452e4c1f7188b8f0519d36d70d935b2
- Restored production shell: 2d52e8e98eb913ca5fbfa3c508eb864a685ee11b7d503558cb0b2e2d517b3f48

Node subprocess.run waits/reaps every complete owner. Original test.after removes its allocated fixture roots. The historical cleanup record was `{"processSnapshotExit":0,"matchingOwnedFixtureProcesses":[],"allOwnedSourceRestored":true}`. No process from this proof remains when the snapshot check succeeds with an empty inventory. No production/path mutations remain.

## Inspectable reproduction

The results above are historical, recorded on 2026-10-13. This documentation repair
checks the Git source and mutation hashes; it does not claim fresh test results.
Historical raw reports remain local and are not bundled. The relevant failure
excerpts and exact executed production edits are included here; no private proof
file is needed to reconstruct the checks.

Run the block from a repository checkout with the public `base` and `head` Git
revisions below. Fetch those public PR/revisions first if they are absent.
Python 3.12+, Git and Node are required. No dependency installation is needed. Provisioning requires
Bash and localhost binding permission; its existing tool-availability skip can
vary with `flock`/Git availability. The recipe accepts either execution or that
one named skip and adjusts only its passing/skip counts. All other case and
intended failure counts must match. The table retains the historical host results.

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
 'head': '27865cb2c85921ef3c996c27bc2d662776a35d29',
 'owner': 'scripts/__tests__/provision-worktree-self-heal.test.mjs',
 'kind': 'tap',
 'hashes': {'scripts/__tests__/provision-worktree-self-heal.test.mjs': '29d758d74d32418ea4de53c6cea4409d29c5310252a10d558c19e08ba36a670a',
            'scripts/provision-worktree.sh': '2d52e8e98eb913ca5fbfa3c508eb864a685ee11b7d503558cb0b2e2d517b3f48'},
 'candidate_hash': 'ffacee5de45871dfe9bb2613aa05ffadb452e4c1f7188b8f0519d36d70d935b2',
 'baseline': [35, 34, 0, 1],
 'candidate': [34, 33, 0, 1],
 'mutations': [{'name': 'database-path-escape',
                'path': 'scripts/provision-worktree.sh',
                'changes': [['      embeddedPostgresDataDir: path.resolve(instanceRoot, "db"),\n',
                             '      embeddedPostgresDataDir: path.resolve(worktreeHome, "..", '
                             '"misdirected-worktree-db"),\n']],
                'hash': '9fa060a915ec993b91d95ccf3c8f66a65f483713e8a82ffe194f667c4dc91066',
                'counts': [34, 32, 1, 1],
                'guard': 'isolates fallback configuration and reconciles deployment mode from the '
                         'registered source when reusing a guest config',
                'message': 'to live under'}]}

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
            assert actual[3] in (0, 1), (label, "unexpected skip count")
            if actual[3]:
                assert re.search(
                    r"^ok \d+ - repairs an unhealthy base install under the lock and then uses the CLI # SKIP flock or git not available on this host$",
                    output, re.M), (label, "unexpected skipped case")
            expected = expected.copy()
            expected[1] += expected[3] - actual[3]
            expected[3] = actual[3]
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
database-path-escape-original
falls back to an isolated config when the base CLI cannot boot
'expected <fixture-root>/misdirected-worktree-db to live under <fixture-root>/paperclip-provision-home-GzsiQq'
reconciles deployment mode from the registered source when reusing a guest config
|-
    The input did not match the regular expression /Reusing existing isolated Paperclip worktree config/. Input:

    'existing worktree config path is outside <fixture-root>/paperclip-provision-worktree-kroaza-bc89219c87b9: <fixture-root>/misdirected-worktree-db\n' +
      'Existing isolated Paperclip worktree config is stale for this host; regenerating.\n' +
      'No usable paperclipai CLI found; writing isolated fallback config without DB seeding.\n'
database-path-escape-keeper
isolates fallback configuration and reconciles deployment mode from the registered source when reusing a guest config
'expected <fixture-root>/misdirected-worktree-db to live under <fixture-root>/paperclip-provision-home-Rv7iS2'
```
