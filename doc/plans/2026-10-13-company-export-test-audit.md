# CompanyExport proof receipt

Historical proof base `8e955181d8a3776acc86e4662de3c77933231a76`; OpenAI GPT-6.1-Sol.

Two same-render retirements preserve the complete original check union: empty fidelity-panel absence joins the automatic-preview keeper; initial disabled/unchecked attachment and dimmed task-folder checks join the rich-download keeper before clicks. Existing fidelity API and 3-of-6 file-count assertions remain. Whole-program AST proof confirms all other fixtures, hooks, provider inputs, actions and cases unchanged.

| Full owner phase | Passed | Failed / skipped | Exit |
|---|---:|---:|---:|
| Baseline | 13 | 0 / 0 | 0 |
| Candidate | 11 | 0 / 0 | 0 |
| Full revert | 13 | 0 / 0 | 0 |
| Restored candidate | 11 | 0 / 0 | 0 |

Four independent actual production controls each selected one keeper and exited 1 at its intended guard: render an empty fidelity panel (line 253); enable disabled attachments (317); check disabled attachments (318); stop dimming the excluded tasks directory (319). Each had 0 passing / 1 failing selected case; 10 other cases were filtered out, with no source skips added. Production bytes restored after each; final SHA-256 `52775673ad41a2156e9e3f23016ca7e957fc552930139b2048685a55c10d6d2d`.

Saving: 2 registered root/provider renders, 14 net test lines (5 added / 19 removed), no measured runtime claim. Initial anchored selector selected zero cases and was rejected by the harness; log/JSON preserved, all controls rerun with corrected unique selectors. Existing React act warnings remain. Diff check passes. No broad suite/typecheck/build for this proof-only proposal. No production changes, branch, commit, push or PR.

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

spec = {'base': '8e955181d8a3776acc86e4662de3c77933231a76',
 'head': '34270ee5c767a561fe34fe57a6d807d1a9496f70',
 'owner': 'ui/src/pages/CompanyExport.test.tsx',
 'kind': 'ui',
 'hashes': {'ui/src/pages/CompanyExport.test.tsx': '096af584a2f94cd423a59296b6e7af160081e95f6234747573973197f766cb0c',
            'ui/src/pages/CompanyExport.tsx': '52775673ad41a2156e9e3f23016ca7e957fc552930139b2048685a55c10d6d2d'},
 'candidate_hash': 'a6cceb2266154c372d9081ec79ca3dcd8e3acb6994e2599bbc98dd11f8988012',
 'baseline': [13, 13, 0, 0],
 'candidate': [11, 11, 0, 0],
 'mutations': [{'name': 'empty-fidelity',
                'path': 'ui/src/pages/CompanyExport.tsx',
                'changes': [['{fidelityReport && fidelityReport.warnings.length > 0 && (',
                             '{fidelityReport && (']],
                'hash': 'a9f8c23c46b994199221719de840292a9c8c2c9ff613e5f4e220441b5c4cd0ea',
                'counts': [11, 0, 1, 10],
                'guard': 'loads the no-task export automatically without an interstitial',
                'message': "AssertionError: expected 'Paperclip exportExporting 1 of 1 file…' not to "
                           "contain 'Not included in this export'",
                'selector': 'loads the no-task export automatically without an interstitial',
                'line': 253},
               {'name': 'attachments-enabled',
                'path': 'ui/src/pages/CompanyExport.tsx',
                'changes': [['const disabled = isAttachments && '
                             '!isAttachmentsCategoryEnabled(categories);',
                             'const disabled = false;']],
                'hash': '0b978fefc8f332f4863d16d8af9a76ebdd2d6916fc3778c588fceee08173a3ae',
                'counts': [11, 0, 1, 10],
                'guard': 'keeps task history opt-in, then requests all selected files on download',
                'message': 'AssertionError: expected false to be true // Object.is equality',
                'selector': 'keeps task history opt-in, then requests all selected files on download',
                'line': 317},
               {'name': 'attachments-checked',
                'path': 'ui/src/pages/CompanyExport.tsx',
                'changes': [['const checked = categories[key] && !disabled;',
                             'const checked = isAttachments && disabled ? true : categories[key] && '
                             '!disabled;']],
                'hash': '966c964b9b8c124cb60c280146619eca379095a89ddb8930420365614a72498d',
                'counts': [11, 0, 1, 10],
                'guard': 'keeps task history opt-in, then requests all selected files on download',
                'message': 'AssertionError: expected true to be false // Object.is equality',
                'selector': 'keeps task history opt-in, then requests all selected files on download',
                'line': 318},
               {'name': 'undimmed-task-folder',
                'path': 'ui/src/pages/CompanyExport.tsx',
                'changes': [['if (!anyIncluded) tones[node.path] = "muted";',
                             'if (!anyIncluded && node.path !== "tasks") tones[node.path] = "muted";']],
                'hash': 'f1f8f968e1ffe2bd26d4158ba86f6639531131bd96d728a0b62811d6f27f71ab',
                'counts': [11, 0, 1, 10],
                'guard': 'keeps task history opt-in, then requests all selected files on download',
                'message': "AssertionError: expected 'group grid w-full grid-cols-(--gtc-3)…' to "
                           "contain 'opacity-50'",
                'selector': 'keeps task history opt-in, then requests all selected files on download',
                'line': 319}]}

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
empty-fidelity / loads the no-task export automatically without an interstitial
AssertionError: expected 'Paperclip exportExporting 1 of 1 file…' not to contain 'Not included in this export'
CompanyExport.test.tsx:253
attachments-enabled / keeps task history opt-in, then requests all selected files on download
AssertionError: expected false to be true // Object.is equality
CompanyExport.test.tsx:317
attachments-checked / keeps task history opt-in, then requests all selected files on download
AssertionError: expected true to be false // Object.is equality
CompanyExport.test.tsx:318
undimmed-task-folder / keeps task history opt-in, then requests all selected files on download
AssertionError: expected 'group grid w-full grid-cols-(--gtc-3)…' to contain 'opacity-50'
CompanyExport.test.tsx:319
```
