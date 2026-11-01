import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrace } from "../../../scripts/ci-profile/trace.mjs";
import { sendEvents } from "../../../scripts/ci-profile/export.mjs";
import { associatedProfilePr, ciOwners, trustedOwnerIds } from "../../../scripts/ci-profile/authorize.mjs";

const at = (seconds) => new Date(1_800_000_000_000 + seconds * 1000).toISOString();
const run = {
  id: 42, run_attempt: 1, run_number: 7, status: "completed", conclusion: "failure",
  repository: { id: 1170821064, full_name: "paperclipai/paperclip" }, head_repository: { id: 99 },
  actor: { id: 123, type: "User" }, triggering_actor: { id: 123, type: "User" },
  head_sha: "abc", head_branch: "branch", created_at: at(0), run_started_at: at(0),
  html_url: "https://github.com/paperclipai/paperclip/actions/runs/42",
};
const job = (id, name, start, end) => ({
  id, run_id: 42, run_attempt: 1, name: `ci / ${name}`, status: "completed",
  conclusion: "success", created_at: at(1), started_at: at(start), completed_at: at(end),
  labels: ["ubuntu-latest"], steps: [
    { number: 1, name: "Initialize CI profile", started_at: at(start), completed_at: at(start + 1), conclusion: "success" },
    { number: 2, name: "Tests", started_at: at(start + 1), completed_at: at(end), conclusion: "success" },
  ],
});
const jobs = [job(1, "first", 2, 12), job(2, "second", 3, 20)];
const record = (fields) => ({ version: 1, runId: "42", attempt: "1", invocation: "invocation", job: "first", framework: "vitest", ...fields });

test("one wall-clock trace includes parallel jobs, wait, and every step", () => {
  const trace = buildTrace(run, jobs);
  assert.equal(trace.wallMs, 20000);
  assert.equal(trace.events[0].data.duration_ms, 20000);
  assert.equal(trace.events.filter((event) => event.data["ci.kind"] === "job").length, 2);
  assert.equal(trace.events.filter((event) => event.data["ci.kind"] === "step").length, 4);
  assert.equal(trace.events.filter((event) => event.data["ci.kind"] === "wait").length, 2);
  assert.equal(new Set(trace.events.map((event) => event.data["trace.trace_id"])).size, 1);
  assert.equal(trace.events.find((event) => event.data.name === "ci / second").data["ci.finishes_last"], true);
  assert.equal(trace.events[0].data.error, true);
});

test("file/test hierarchy keeps runner timestamps and rejects unrelated artifact data", () => {
  const records = [
    record({ kind: "job" }), record({ kind: "job", job: "second" }),
    record({ kind: "start" }), record({ kind: "end" }),
    record({ kind: "file", id: "file", name: "a.test.ts", file: "a.test.ts", start: Date.parse(at(4)), duration: 6000, status: "passed" }),
    record({ kind: "test", id: "case", parent: "file", name: "runs", file: "a.test.ts", start: Date.parse(at(5)), duration: 100, status: "passed", secret: "must not leave artifact" }),
    record({ kind: "test", id: "foreign", runId: "41", name: "wrong run" }),
  ];
  const trace = buildTrace(run, jobs, records);
  const file = trace.events.find((event) => event.data.name === "a.test.ts");
  const entry = trace.events.find((event) => event.data.name === "runs");
  assert.equal(entry.time, at(5));
  assert.equal(entry.data["trace.parent_id"], file.data["trace.span_id"]);
  assert.equal(file.data["trace.parent_id"], trace.events.find((event) => event.data.name === "Tests").data["trace.span_id"]);
  assert.equal(trace.events.some((event) => event.data.name === "wrong run"), false);
  assert.doesNotMatch(JSON.stringify(trace), /must not leave artifact/);
  assert.equal(trace.events[0].data["ci.profile_complete"], false);
  assert.match(trace.warnings.join(), /1 invalid/);
});

test("short files belong to the latest containing step despite second-precision boundaries", () => {
  const records = [record({ kind: "file", id: "file", name: "short.test.ts", file: "short.test.ts",
    start: Date.parse(at(3)) + 100, duration: 50, status: "passed" })];
  const trace = buildTrace(run, jobs, records);
  const file = trace.events.find((event) => event.data.name === "short.test.ts");
  const step = trace.events.find((event) => event.data.name === "Tests");
  assert.equal(file.data["trace.parent_id"], step.data["trace.span_id"]);
});

test("cancelled reporters and missing shards remain explicit", () => {
  const trace = buildTrace({ ...run, conclusion: "cancelled" }, jobs, [record({ kind: "job" }), record({ kind: "start" })]);
  assert.equal(trace.events[0].data["ci.profile_complete"], false);
  assert.match(trace.warnings.join(), /Missing timing artifacts for 1 jobs/);
  assert.match(trace.warnings.join(), /1 test invocations/);
});

test("a completely absent reporter invocation cannot hide behind a successful sibling", () => {
  const records = [
    record({ kind: "job" }), record({ kind: "job", job: "second" }),
    record({ kind: "expected" }), record({ kind: "start" }), record({ kind: "end" }),
    record({ kind: "file", id: "file", name: "a.test.ts", file: "a.test.ts", start: Date.parse(at(4)), duration: 100, status: "passed" }),
    record({ kind: "expected", invocation: "reporter-never-loaded" }),
  ];
  const trace = buildTrace(run, jobs, records);
  assert.equal(trace.events[0].data["ci.profile_complete"], false);
  assert.equal(trace.events[0].data["ci.expected_invocations"], 2);
  assert.equal(trace.events[0].data["ci.reported_invocations"], 1);
  assert.match(trace.warnings.join(), /1 test invocations/);
});

test("coverage is conservative after failures and does not merge framework invocation IDs", () => {
  const records = [
    record({ kind: "job" }), record({ kind: "job", job: "second" }),
    record({ kind: "expected" }), record({ kind: "start" }), record({ kind: "end" }),
  ];
  assert.equal(buildTrace({ ...run, conclusion: "success" }, jobs, records).events[0].data["ci.profile_complete"], true);
  assert.equal(buildTrace(run, jobs, records).events[0].data["ci.profile_complete"], false);
  const trace = buildTrace({ ...run, conclusion: "success" }, jobs, [
    ...records, record({ framework: "node", kind: "expected" }),
  ]);
  assert.equal(trace.events[0].data["ci.profile_complete"], false);
  assert.equal(trace.events[0].data["ci.expected_invocations"], 2);
  assert.equal(trace.events[0].data["ci.reported_invocations"], 1);
});

test("complete reporter pairs count without launcher intent, and long test names remain timed", () => {
  const records = [
    record({ kind: "job" }), record({ kind: "job", job: "second" }),
    record({ framework: "node", kind: "start" }), record({ framework: "node", kind: "end" }),
    record({ kind: "test", id: "long", parent: "file", name: "x".repeat(5000),
      file: "a.test.ts", start: Date.parse(at(4)), duration: 100, status: "passed" }),
    record({ kind: "file", id: "file", name: "a.test.ts", file: "a.test.ts",
      start: Date.parse(at(4)), duration: 100, status: "passed" }),
  ];
  const trace = buildTrace({ ...run, conclusion: "success" }, jobs, records);
  assert.equal(trace.events[0].data["ci.profile_complete"], true);
  assert.equal(trace.events[0].data["ci.test_count"], 1);
  assert.equal(trace.events.find((event) => event.data["ci.kind"] === "test").data.name.length, 256);
});

test("trusted policy commands work with both current and pre-profile checkouts", () => {
  const source = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  const block = source.split("      - name: Select compatible Node test command\n")[1].split("\n      - name:")[0];
  const script = block.split("        run: |\n")[1].split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const directory = mkdtempSync(path.join(tmpdir(), "ci-profile-legacy-"));
  try {
    writeFileSync(path.join(directory, "probe.test.cjs"), 'require("node:test")("old checkout works", () => {});');
    for (const current of [false, true]) {
      if (current) {
        mkdirSync(path.join(directory, "scripts"));
        symlinkSync(fileURLToPath(new URL("../../../scripts/ci-profile", import.meta.url)), path.join(directory, "scripts/ci-profile"));
      }
      const env = { ...process.env, GITHUB_ENV: path.join(directory, "env"), PAPERCLIP_CI_PROFILE: "false" };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync("bash", ["-c", `${script}\nsource "$GITHUB_ENV"\nnode "$CI_NODE_TEST" probe.test.cjs`], {
        cwd: directory, env, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(readFileSync(env.GITHUB_ENV, "utf8"), current ? /CI_NODE_TEST=scripts\/ci-profile\/node-test.mjs/ : /CI_NODE_TEST=--test/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("reruns use separate IDs and clocks and cannot mix job attempts", () => {
  const rerun = { ...run, run_attempt: 2, run_started_at: at(2) };
  assert.throws(() => buildTrace(rerun, jobs), /another run or attempt/);
  const trace = buildTrace(rerun, jobs.map((entry) => ({ ...entry, run_attempt: 2 })));
  assert.equal(trace.wallMs, 18000);
  assert.notEqual(trace.traceId, buildTrace(run, jobs).traceId);
  assert.equal(trace.events[0].data["ci.partial_rerun"], true);
  assert.throws(() => buildTrace({ ...run, status: "in_progress" }, jobs), /complete/);
});

test("partial reruns exclude old jobs that GitHub relabels with the new attempt number", () => {
  const rerun = { ...run, run_attempt: 2, run_started_at: at(30) };
  const inventory = [
    { ...job(1, "carried build", 2, 12), run_attempt: 2 },
    { ...job(3, "retried tests", 32, 50), run_attempt: 2, created_at: at(31) },
  ];
  const trace = buildTrace(rerun, inventory);
  assert.equal(trace.wallMs, 20000);
  assert.equal(trace.jobCount, 1);
  assert.equal(trace.events[0].data["ci.carried_job_count"], 1);
  assert.equal(trace.events.some((event) => event.data.name === "ci / carried build"), false);
  assert.equal(trace.events[0].data["ci.profile_complete"], false);
  assert.match(trace.warnings.join(), /1 completed jobs carried over/);
  assert.throws(() => buildTrace(rerun, inventory.slice(0, 1)), /No jobs executed/);
});

test("label alone cannot authorize outsiders, bots, stale revisions or outsider reruns", () => {
  const pr = { user: { id: 123, type: "User" }, base: { repo: run.repository }, head: { repo: { id: 99 }, sha: "abc" }, labels: [{ name: "profile-ci" }] };
  assert.equal(associatedProfilePr(run, [pr], [123]), pr);
  for (const changed of [
    { ...pr, labels: [] },
    { ...pr, head: { ...pr.head, sha: "next" } },
    { ...pr, head: { ...pr.head, repo: { id: 100 } } },
    { ...pr, user: { id: 999, type: "User" } },
    { ...pr, user: { id: 123, type: "Bot" } },
    { ...pr, base: { repo: { ...run.repository, id: 100 } } },
  ]) assert.equal(associatedProfilePr(run, [changed], [123]), undefined);
  assert.equal(associatedProfilePr({ ...run, actor: { id: 999, type: "User" } }, [pr], [123]), undefined);
  assert.equal(associatedProfilePr({ ...run, triggering_actor: { id: 999, type: "User" } }, [pr], [123]), undefined);
  assert.equal(associatedProfilePr({ ...run, repository: { ...run.repository, id: 100 } }, [pr], [123]), undefined);
  assert.equal(associatedProfilePr(run, [pr], []), undefined);
});

test("profiling uses only infrastructure CODEOWNERS resolved at trusted master", () => {
  const source = '.github/** @owner @second\ndoc/** @outsider\n';
  assert.deepEqual(ciOwners(source), ["owner", "second"]);
  for (const invalid of ['', '.github/**', '.github/** @org/team', '.github/** @owner\n/.github/** @other']) {
    assert.throws(() => ciOwners(invalid), /CODEOWNERS/);
  }
  const endpoints = [];
  const sha = "a".repeat(40);
  assert.deepEqual(trustedOwnerIds((endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.endsWith('git/ref/heads/master')) return { object: { sha } };
    if (endpoint.endsWith(`CODEOWNERS?ref=${sha}`)) return { encoding: 'base64', content: Buffer.from(source).toString('base64') };
    return { id: endpoint === '/users/owner' ? 123 : 456, type: 'User' };
  }), [123, 456]);
  assert.deepEqual(endpoints, [
    '/repos/paperclipai/paperclip/git/ref/heads/master',
    `/repos/paperclipai/paperclip/contents/.github/CODEOWNERS?ref=${sha}`, '/users/owner', '/users/second',
  ]);
});

test("export paces batches and retries only rejected transient events", async () => {
  const events = Array.from({ length: 501 }, () => ({ data: {} }));
  const sizes = [];
  const pauses = [];
  await sendEvents(events, "test-only", "paperclip-ci", async (url, options) => {
    assert.equal(url, "https://api.honeycomb.io/1/batch/paperclip-ci");
    assert.equal(options.redirect, "error");
    const size = JSON.parse(options.body).length;
    sizes.push(size);
    return { ok: true, json: async () => Array.from({ length: size }, () => ({ status: 202 })) };
  }, async (ms) => { pauses.push(ms); });
  assert.deepEqual(sizes, [250, 250, 1]);
  assert.deepEqual(pauses, [1000, 1000]);
  let calls = 0;
  const retried = [];
  await sendEvents([{ data: { id: 1 } }, { data: { id: 2 } }], "test-only", "paperclip-ci", async (_url, options) => {
    const batch = JSON.parse(options.body);
    retried.push(batch.map((event) => event.data.id));
    calls += 1;
    return { ok: true, json: async () => calls === 1 ? [{ status: 202 }, { status: 429 }] : [{ status: 202 }] };
  }, async (ms) => { pauses.push(ms); });
  assert.deepEqual(retried, [[1, 2], [2]]);
  assert.equal(pauses.at(-1), 1000);
  await assert.rejects(sendEvents([events[0]], "test-only", "paperclip-ci", async () => ({ ok: true, json: async () => [{ status: 400 }] })), /status 400/);
});

function secretReference(text, includeQuoted = false) {
  for (const line of text.split(/[\r\n\u2028\u2029]/)) {
    const start = line.indexOf("HONEYCOMB");
    if (start >= 0 && line.indexOf("KEY", start + "HONEYCOMB".length) >= 0) return true;
  }
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf("${{", offset);
    if (start < 0) return false;
    offset = start + 3;
    let quoted = false;
    let expression = "";
    while (offset < text.length) {
      const char = text[offset];
      if (char === "'") {
        if (quoted && text[offset + 1] === "'") {
          offset += 2;
          continue;
        }
        quoted = !quoted;
        expression += includeQuoted ? char : " ";
      } else if (!quoted) {
        if (char === "}" && text[offset + 1] === "}") {
          offset += 2;
          break;
        }
        expression += char;
      } else if (includeQuoted) {
        expression += char;
      }
      offset += 1;
    }
    if (/\bsecrets\b/.test(expression)) return true;
  }
  return false;
}

function assertNoPrWorkflowCredentials(source) {
  assert.equal(secretReference(source, true), false);
}

test("PR credential guard permits filenames but rejects secret expressions", () => {
  assertNoPrWorkflowCredentials("run: node --test scripts/docker-compose-secrets.test.mjs");
  assertNoPrWorkflowCredentials("if: ${{ always() }}\nrun: node --test scripts/docker-compose-secrets.test.mjs");
  assertNoPrWorkflowCredentials("if: ${{ startsWith(github.ref, 'ref') }}\nrun: 'node --test scripts/docker-compose-secrets.test.mjs'");
  for (const source of ["env: ${{ secrets.EXAMPLE }}", "env: ${{ secrets['EXAMPLE'] }}", "env: ${{ toJSON(secrets) }}", "env: ${{ format('}}', secrets.EXAMPLE) }}",
    "# Expressions start with '${{'.\nTOKEN: ${{ secrets.PR_TOKEN }}",
    "name: Example # Expressions start with '${{'.\nTOKEN: ${{ secrets.PR_TOKEN }}"]) {
    assert.throws(() => assertNoPrWorkflowCredentials(source));
  }
  for (const source of [
    "${{secrets.EXAMPLE_TOKEN}}", '${{ secrets["EXAMPLE_TOKEN"] }}',
    "${{ failure() && secrets.EXAMPLE_TOKEN }}", "${{\n secrets.EXAMPLE_TOKEN\n}}",
    "${{ format('{0}', secrets.EXAMPLE_TOKEN) }}", "HONEYCOMB_CI_API_KEY",
  ]) assert.throws(() => assertNoPrWorkflowCredentials(source));
  assert.throws(() => assertNoPrWorkflowCredentials("HONEYCOMB_API_KEY: example"));
  assert.throws(() => assertNoPrWorkflowCredentials("${{ format('secrets.EXAMPLE', 'literal') }}"));
});

test("workflow exporter runs trusted code and keeps keys out of the PR jobs", () => {
  const workflow = readFileSync(new URL("../../workflows/ci-profile.yml", import.meta.url), "utf8");
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /startsWith\(github.event.workflow_run.display_title/);
  assert.match(workflow, /environment: ci-profiling/);
  assert.doesNotMatch(workflow, /head_sha|secrets: inherit|contents: write|pull-requests: write|pnpm install/);
  const pr = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
  assert.equal(secretReference("run: node --test scripts/docker-compose-secrets.test.mjs"), false);
  for (const lookup of ["${{ secrets.PR_TOKEN }}", "${{ secrets['PR_TOKEN'] }}", "${{\n secrets.PR_TOKEN\n }}", "${{ toJSON(secrets) }}", "${{ secrets.HONEYCOMB_API_KEY }}"]) {
    assert.equal(secretReference(lookup), true);
  }
  for (const lookup of [
    "${{ format('Bearer {0}', secrets.PR_TOKEN) }}",
    "${{ format('{0}', toJSON(secrets)) }}",
    "${{ format('{{Bearer}} {0}', secrets['PR_TOKEN']) }}",
    "${{ format('it''s {0}',\n secrets.PR_TOKEN) }}",
  ]) {
    assert.equal(secretReference(lookup), true);
  }
  for (const nonSecret of [
    "${{ format('secrets.PR_TOKEN', 'literal') }}",
    "${{ github.sha }}\nrun: node --test scripts/docker-compose-secrets.test.mjs",
  ]) {
    assert.equal(secretReference(nonSecret), false);
  }
  const escapedExpressions = [28, 10_000].flatMap(count => {
    const expression = "${{ format('" + "it''s ".repeat(count) + "{0}', github.sha) }}";
    return [expression, expression.replace("github.sha", "secrets.PR_TOKEN"), expression.replace("github.sha", "toJSON(secrets)")];
  });
  const boundedScan = spawnSync(process.execPath, ["-e", `const fs=require('node:fs');const scan=${secretReference.toString()};process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(0,'utf8')).map(value=>[scan(value),scan(value,true)])));`], {
    input: JSON.stringify(escapedExpressions),
    encoding: "utf8", timeout: 2_000,
  });
  assert.equal(boundedScan.status, 0, boundedScan.error?.message);
  assert.deepEqual(JSON.parse(boundedScan.stdout), [[false, false], [true, true], [true, true], [false, false], [true, true], [true, true]]);
  assert.equal(secretReference(pr), false);
  assertNoPrWorkflowCredentials(pr);
  assert.match(pr, /if: always\(\) && env.PAPERCLIP_CI_PROFILE == 'true'/);
  assert.doesNotMatch(pr, /PAPERCLIP_CI_PROFILE:.*labels/);
  assert.equal(pr.match(/PAPERCLIP_CI_PROFILE: \$\{\{ needs.gate.outputs.profile_ci \}\}/g).length, 9);
  // upload-artifact excludes files inside dot-directories by default. Keep
  // this opt-in scoped to timing NDJSON, never the workspace or other secrets.
  assert.equal(pr.match(/path: \.ci-profile\/\*\.ndjson\n {10}include-hidden-files: true/g).length, 9);
  const routing = readFileSync(new URL("../../workflows/ci-routing.yml", import.meta.url), "utf8");
  assert.match(routing, /PROFILE_CI: \$\{\{ steps.profile.outputs.profile_ci \}\}/);
  assert.match(routing, /\/git\/ref\/heads\/master/);
  assert.match(routing, /authorize\.mjs\?ref=\$TRUSTED_PROFILE_SHA/);
});

test("artifact parsing never extracts paths or executes files and rejects oversized records", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-artifact-test-"));
  const archive = path.join(directory, "artifact.zip");
  const reader = fileURLToPath(new URL("../../../scripts/ci-profile/read-artifact.py", import.meta.url));
  try {
    execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escape.ndjson', '{\"kind\":\"test\"}\\n'); z.close()", archive]);
    const result = execFileSync("python3", [reader, archive], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(result), { kind: "test" });
    assert.equal(existsSync(path.join(directory, "escape.ndjson")), false);
    execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('large.ndjson', 'x'*33000); z.close()", archive]);
    assert.notEqual(spawnSync("python3", [reader, archive]).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
