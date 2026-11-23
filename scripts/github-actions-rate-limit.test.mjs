import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionsReader } from "./github-actions-reader.mjs";

function fixture(responses, options = {}) {
  let clock = Date.UTC(2000, 0, 1);
  const calls = [], waits = [], logs = [];
  const api = createActionsReader({
    token: "fixture-secret", tokenSource: "github.token", now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; },
    log: message => logs.push(message),
    fetchImpl: async () => {
      calls.push(clock);
      const next = responses.shift();
      assert.ok(next, "Unexpected extra API request");
      return new Response(JSON.stringify({ message: "fixture-private-body", ok: true }), next);
    }, ...options,
  });
  return { api, calls, waits, logs };
}

const reset = String(Date.UTC(2000, 0, 1) / 1000 + 120);

test("primary throttling waits for the real reset and emits only safe quota diagnostics", async () => {
  const f = fixture([{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "1000", "x-ratelimit-reset": reset,
    "x-ratelimit-resource": "core" } }, { status: 200 }]);
  await f.api("/repos/example/repo/actions/runs");
  assert.deepEqual(f.waits, [121_000]);
  assert.equal(f.calls[1] - f.calls[0], 121_000);
  assert.match(f.logs[0], /credential: github.token.*resource: core.*limit: 1000.*remaining: 0.*reset: 2000-01-01T00:02:00.000Z/);
  assert.doesNotMatch(f.logs.join(""), /fixture-secret|fixture-private-body|example\/repo/);
});

test("a reset or Retry-After outside the budget stops without an early retry", async () => {
  for (const headers of [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }, { "retry-after": "3600" }]) {
    const f = fixture([{ status: 403, headers }], { maxRetryAfterMs: 60_000 });
    await assert.rejects(f.api("/repos/x"), /GitHub API rate limited/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
  }
});

test("the caller deadline accounts for the entire server wait", async () => {
  const f = fixture([{ status: 429, headers: { "retry-after": "120" } }], { deadlineAt: () => Date.UTC(2000, 0, 1) + 60_000 });
  await assert.rejects(f.api("/repos/x"), /GitHub API rate limited/);
  assert.deepEqual(f.waits, []);
  assert.equal(f.calls.length, 1);
});

test("secondary throttling without a reset backs off for at least a minute", async () => {
  const f = fixture([{ status: 429 }, { status: 429 }, { status: 200 }]);
  await f.api("/repos/x");
  assert.deepEqual(f.waits, [60_000, 120_000]);
});

test("Retry-After dates and a later primary reset are both respected", async () => {
  const f = fixture([{ status: 429, headers: { "retry-after": "Sat, 01 Jan 2000 00:03:00 GMT", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }, { status: 200 }]);
  await f.api("/repos/x");
  assert.deepEqual(f.waits, [180_000]);
});

test("quota errors stay explicit when attempts are exhausted and do not guess a token source", async () => {
  const f = fixture([{ status: 429, headers: { "x-ratelimit-resource": "fixture-private-body", "x-ratelimit-limit": "unsafe-value" } }],
    { attempts: 1, tokenSource: "fixture-secret" });
  await assert.rejects(f.api("/repos/x"), error => {
    assert.equal(error.name, "GitHubActionsRateLimitError");
    assert.match(error.message, /HTTP 429; credential: configured credential/);
    assert.doesNotMatch(error.message, /fixture-secret|fixture-private-body|unsafe-value|github.token/);
    return true;
  });
});

test("an ordinary forbidden response is still an immediate permission failure", async () => {
  const f = fixture([{ status: 403, headers: { "x-ratelimit-remaining": "999" } }]);
  await assert.rejects(f.api("/repos/x"), /GitHub Actions read failed \(HTTP 403\)/);
  assert.deepEqual(f.waits, []);
});

test("transient service failures honor Retry-After seconds and dates", async () => {
  for (const retryAfter of ["30", "Sat, 01 Jan 2000 00:00:30 GMT"]) {
    const f = fixture([{ status: 503, headers: { "retry-after": retryAfter } }, { status: 200 }]);
    await f.api("/repos/x");
    assert.deepEqual(f.waits, [30_000]);
    assert.equal(f.calls[1] - f.calls[0], 30_000);
  }
});

test("transient Retry-After waits outside either budget fail without an early retry", async () => {
  for (const options of [{ maxRetryAfterMs: 20_000 }, { deadlineAt: () => Date.UTC(2000, 0, 1) + 20_000 }]) {
    const f = fixture([{ status: 503, headers: { "retry-after": "30" } }], options);
    await assert.rejects(f.api("/repos/x"), /GitHub Actions read failed \(HTTP 503\)/);
    assert.deepEqual(f.waits, []);
    assert.equal(f.calls.length, 1);
  }
});


test("the release CLI reports safe quota evidence and cannot publish proof or cancel work", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-quota-cli-"));
  try {
    const mock = join(dir, "fetch.mjs"), output = join(dir, "outputs");
    writeFileSync(mock, `globalThis.fetch = async (_url, init) => {
      if (init?.method && init.method !== "GET") throw new Error("Unexpected mutation");
      return new Response(JSON.stringify({ message: "fixture-private-body" }), { status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "1000", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 7200) } });
    };`);
    for (const args of [[], ["--require-proof"], ["--check-proof"]]) {
      writeFileSync(output, "");
      const result = spawnSync(process.execPath, ["--import", mock, new URL("./watch-release-source.mjs", import.meta.url).pathname, ...args], {
        encoding: "utf8", timeout: 5000, env: { ...process.env, GITHUB_TOKEN: "fixture-secret", GITHUB_TOKEN_SOURCE: "github.token",
          GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master", GITHUB_SHA: "a".repeat(40),
          GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: output },
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /::error title=GitHub API rate limited::GitHub API rate limited.*credential: github.token.*limit: 1000.*remaining: 0.*reset:/);
      assert.doesNotMatch(result.stderr + result.stdout, /fixture-secret|fixture-private-body|Unexpected mutation/);
      assert.equal(readFileSync(output, "utf8"), "");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
