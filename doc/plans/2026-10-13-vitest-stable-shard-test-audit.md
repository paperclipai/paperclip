# Proven shard test consolidation

Historical proof base: #16099 exact tree 8e955181d8a3776acc86e4662de3c77933231a76, extracted with git archive into an isolated temporary snapshot. Node built-in tests require no dependency installation. All runs serial; no shared checkout edits, commits, pushes or PRs.

Historical result: PROVEN. Retire three repeated executions, preserving all original assertions in named keepers. Test lines 547 -> 521 (26 net removed, including redundant blank normalization); registered cases 32 -> 29; exactly 22 repeated dry-run Node calls removed: 9 serialized partition launches, 12 PR partition launches, 1 general shard-zero launch. The subprocess delta comes from exact unchanged loop bounds/args, not a sampled timing estimate. No CI-time improvement claimed.

| Complete-owner phase | Tests | Pass | Fail | Exit |
|---|---:|---:|---:|---:|
| baseline | 32 | 32 | 0 | 0 |
| candidate | 29 | 29 | 0 | 0 |
| serialized-duplicate-original | 32 | 31 | 1 | 1 |
| serialized-duplicate-keeper | 29 | 28 | 1 | 1 |
| balance-wrong-bin-original | 32 | 28 | 4 | 1 |
| balance-wrong-bin-keeper | 29 | 25 | 4 | 1 |
| route-wrong-lane-original | 32 | 30 | 2 | 1 |
| route-wrong-lane-keeper | 29 | 28 | 1 | 1 |
| restored-candidate | 29 | 29 | 0 | 0 |
| stack-candidate | 29 | 29 | 0 | 0 |

Every run has 0 skipped/cancelled/todo. The 13 failures in mutation runs are deliberate direct assertion failures; no setup, worker or timeout failures. Unmutated baseline/candidate/restored/integrated controls all pass.

## Exact keeper and regression guards

- Serialized completeness moves into serialized duration-balance keeper. Mutate selectSerializedSuites to duplicate one actual selected file on shard zero. Original and keeper fail `every serialized suite must be selected exactly once`: 159 actual vs 158 expected. Each full owner has exactly one failing case.
- PR duration-balance moves into PR exact-coverage keeper. Invert scheduler's lightest-bin `<` comparison to `>`. Original and keeper directly fail `shard weight spread 5003719.5ms exceeds heaviest suite 136113ms`. Each full owner has four failing cases: synthetic skew balance, empty-manifest uniform balance, real serialized balance, real general balance. All are direct meaningful scheduling assertions; complete coverage alone would miss the regression.
- Route/authz exclusion moves into general partition keeper's existing per-file loop, extending the unchanged guard from shard zero to all shards. Actual executed mutation adds a real serialized route to the dry-run general shard-zero selection: `server/src/__tests__/access-routes-hidden-floor.test.ts`. Original route guard and keeper fail the identical route-exclusion assertion naming that actual path. Original owner has two failures (also total count); keeper has one, reaching the relocated route guard before the count assertion. The executable mutation differs from the discovery-map suggestion only in using the selected dry-run membership expression directly; it protects the same wrong-lane behavior.

Production modifications were applied one at a time; each pair ran complete original and candidate test owners under the same mutated bytes. Original test restored between groups. Every production owner restored in finally and hash-verified. Final restored-candidate run passes 29/29, and isolated baseline snapshot subsequently restores all three owners to exact base bytes.

## Hashes and stacked integration

- Original test SHA256: 3b658c7ff55e35619d70ec8381325d07777c3a46a851edc7f5c5d84a7976eacc
- Proven candidate test SHA256: 58ecff8ddceecb8e0c44240fa3dbf7ae6a9756dbac35b5ad52a14e655cfc8327
- Restored run-vitest-stable.mjs SHA256: 71da62d4317591b590f877436ac16c6185b650b497b7fa843b68c801ecb4f353
- Restored general-server-shard.mjs SHA256: ce809911cac307063fc2746118c1d6229c280e3d866b82ee5b776c89f5c016f3

Fetched public branch into an isolated bare Git directory after the default sandbox attempt failed DNS resolution. Fetch succeeds through approved network escalation and resolves exactly #16106 head 397459400c6e7b18b462dcac3d8886b390ca8e8c. All seven relevant test/production owner blobs were identical to the #16099 proof base. The exact proven patch passes git apply --check, applies without conflict to an extracted #16106 snapshot, retains the candidate hash, and passes the complete owner 29/29 on that snapshot. No cherry-pick or rebase commit was created.

## Inspectable reproduction

The results above are historical, recorded on 2026-10-13. This documentation repair
checks the Git source and mutation hashes; it does not claim fresh test results.
Historical raw reports remain local and are not bundled. The relevant failure
excerpts and exact executed production edits are included here; no private proof
file is needed to reconstruct the checks.

Run the block from a repository checkout with the public `base` and `head` Git
revisions below. Fetch those public PR/revisions first if they are absent.
Python 3.12+, Git and Node are required. No dependency installation is needed.

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

spec = {'base': '8e955181d8a3776acc86e4662de3c77933231a76',
 'head': 'f750c5af0581ea844997d9ea4ee55053a29c775d',
 'owner': 'scripts/__tests__/run-vitest-stable-shard.test.mjs',
 'kind': 'tap',
 'hashes': {'scripts/__tests__/run-vitest-stable-shard.test.mjs': '3b658c7ff55e35619d70ec8381325d07777c3a46a851edc7f5c5d84a7976eacc',
            'scripts/run-vitest-stable.mjs': '71da62d4317591b590f877436ac16c6185b650b497b7fa843b68c801ecb4f353',
            'scripts/general-server-shard.mjs': 'ce809911cac307063fc2746118c1d6229c280e3d866b82ee5b776c89f5c016f3'},
 'candidate_hash': '58ecff8ddceecb8e0c44240fa3dbf7ae6a9756dbac35b5ad52a14e655cfc8327',
 'baseline': [32, 32, 0, 0],
 'candidate': [29, 29, 0, 0],
 'mutations': [{'name': 'balance-wrong-bin',
                'path': 'scripts/general-server-shard.mjs',
                'changes': [['      if (shards[index].totalWeight < shards[target].totalWeight) {\n',
                             '      if (shards[index].totalWeight > shards[target].totalWeight) {\n']],
                'hash': 'a654c5cbfed571ffff107623bc1dec25a5aa3982084d608f6cade19a0d84d75d',
                'counts': [29, 25, 4, 0],
                'guard': '12 PR without-chat shards plus the dedicated chat and native-runner lanes '
                         'cover the original server group exactly',
                'message': 'shard weight spread 5003719.5ms exceeds heaviest suite 136113ms'},
               {'name': 'route-wrong-lane',
                'path': 'scripts/run-vitest-stable.mjs',
                'changes': [['              ? selectGeneralServerShard(\n',
                             '              ? [...(options.shardIndex === 0 ? '
                             '[routeTests.find((routeTest) => '
                             'routeTestPattern.test(routeTest.repoPath)).repoPath] : []), '
                             '...selectGeneralServerShard(\n'],
                            ['                )\n', '                )]\n']],
                'hash': '230d86c678511ae08bdeaea1c86b6b79c433ffedacffc28eb4ede7d4821a743f',
                'counts': [29, 28, 1, 0],
                'guard': 'the general-server shards form a complete, non-overlapping partition',
                'message': 'route/authz suite must stay in the serialized lane, not general-server: '
                           'server/src/__tests__/access-routes-hidden-floor.test.ts'},
               {'name': 'serialized-duplicate',
                'path': 'scripts/run-vitest-stable.mjs',
                'changes': [['  return shardFiles.map((file) => byRepoPath.get(file));\n',
                             '  return [...shardFiles, ...(shardIndex === 0 ? shardFiles.slice(0, 1) : '
                             '[])].map((file) => byRepoPath.get(file));\n']],
                'hash': '13c8a46d0037c0594510404c6e6e81c1bf8559d157754082982a2796fbe0d604',
                'counts': [29, 28, 1, 0],
                'guard': 'the real serialized shard partition is complete, non-overlapping and '
                         'duration-balanced',
                'message': 'every serialized suite must be selected exactly once'}]}

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
balance-wrong-bin-original
duration-aware partition balances skewed weights better than round-robin
'expected near-even shard weights, got 90600, 0, 0'
a missing or malformed manifest degrades to uniform weights
|-
    Expected values to be strictly equal:

    4 !== 0
the real serialized shard partition is duration-balanced
'serialized shard weight spread 2061439ms exceeds heaviest suite 165058ms: 2061439, 0, 0, 0, 0, 0, 0, 0, 0'
the real shard partition is duration-balanced
'shard weight spread 5003719.5ms exceeds heaviest suite 136113ms: 5003719.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0'
balance-wrong-bin-keeper
duration-aware partition balances skewed weights better than round-robin
'expected near-even shard weights, got 90600, 0, 0'
a missing or malformed manifest degrades to uniform weights
|-
    Expected values to be strictly equal:

    4 !== 0
the real serialized shard partition is complete, non-overlapping and duration-balanced
'serialized shard weight spread 2061439ms exceeds heaviest suite 165058ms: 2061439, 0, 0, 0, 0, 0, 0, 0, 0'
12 PR without-chat shards plus the dedicated chat and native-runner lanes cover the original server group exactly
'shard weight spread 5003719.5ms exceeds heaviest suite 136113ms: 5003719.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0'
route-wrong-lane-original
the general-server shards form a complete, non-overlapping partition
|-
    every suite must be selected exactly once

    890 !== 889
a route/authz suite never leaks into the general-server shards
'route/authz suite must stay in the serialized lane, not general-server: server/src/__tests__/access-routes-hidden-floor.test.ts'
route-wrong-lane-keeper
the general-server shards form a complete, non-overlapping partition
'route/authz suite must stay in the serialized lane, not general-server: server/src/__tests__/access-routes-hidden-floor.test.ts'
serialized-duplicate-original
the serialized shards form a complete, non-overlapping partition
|-
    every serialized suite must be selected exactly once

    159 !== 158
serialized-duplicate-keeper
the real serialized shard partition is complete, non-overlapping and duration-balanced
|-
    every serialized suite must be selected exactly once

    159 !== 158
```
