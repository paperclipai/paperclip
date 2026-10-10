import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { downloadPinnedHermesArchive } from "./provision-hermes.mjs";

const archive = Buffer.from("pinned Hermes archive fixture");
const version = {
  commit: "f97608f178d1ffeca59860195ab7da295f7c8e5f",
  archiveSha256: createHash("sha256").update(archive).digest("hex"),
};

test("source download uses the immutable archive and verifies its digest without credentials", async () => {
  const bytes = await downloadPinnedHermesArchive(version, { request: async (url, options) => {
    assert.equal(url, `https://codeload.github.com/NousResearch/hermes-agent/legacy.tar.gz/${version.commit}`);
    assert.deepEqual(Object.keys(options), ["signal"]);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(archive);
  } });
  assert.deepEqual(bytes, archive);
});

test("a throttled source download respects Retry-After before the verified response", async () => {
  let calls = 0;
  const waits = [];
  const bytes = await downloadPinnedHermesArchive(version, {
    request: async () => ++calls === 1
      ? new Response("throttled", { status: 429, headers: { "retry-after": "2" } })
      : new Response(archive),
    wait: async milliseconds => waits.push(milliseconds),
  });
  assert.deepEqual(bytes, archive);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});

test("persistent transient failures stop after three attempts", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(downloadPinnedHermesArchive(version, {
    request: async () => { calls++; return new Response("unavailable", { status: 503 }); },
    wait: async milliseconds => waits.push(milliseconds),
  }), /HTTP 503 after 3 attempts/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("permanent failures and digest mismatches are never retried", async () => {
  for (const [response, error] of [
    [new Response("not found", { status: 404 }), /HTTP 404/],
    [new Response("changed archive"), /source digest mismatch/],
  ]) {
    let calls = 0;
    await assert.rejects(downloadPinnedHermesArchive(version, {
      request: async () => { calls++; return response; },
      wait: async () => assert.fail("This failure must not be retried"),
    }), error);
    assert.equal(calls, 1);
  }
});

test("long throttling delays fail visibly rather than running an unbounded setup", async () => {
  let calls = 0;
  await assert.rejects(downloadPinnedHermesArchive(version, {
    request: async () => { calls++; return new Response("throttled", {
      status: 429, headers: { "retry-after": "3600" },
    }); },
    wait: async () => assert.fail("An excessive server delay must not be ignored"),
  }), /rate limit expires/);
  assert.equal(calls, 1);
});

test("a progressing body may use the remaining overall download deadline", async () => {
  let time = 0;
  const allowances = [];
  const bytes = await downloadPinnedHermesArchive(version, {
    now: () => time,
    timeout: milliseconds => { allowances.push(milliseconds); return new AbortController().signal; },
    request: async () => ({ ok: true, arrayBuffer: async () => { time = 60_000; return archive; } }),
  });
  assert.deepEqual(bytes, archive);
  assert.deepEqual(allowances, [120_000]);
});

test("transport failures during request and body reading retry within the same deadline", async () => {
  let calls = 0;
  let time = 0;
  const allowances = [];
  const bytes = await downloadPinnedHermesArchive(version, {
    now: () => time,
    timeout: milliseconds => { allowances.push(milliseconds); return new AbortController().signal; },
    request: async () => {
      calls++;
      time += 10_000;
      if (calls === 1) throw new TypeError("fetch failed");
      if (calls === 2) return { ok: true, arrayBuffer: async () => { throw new TypeError("body interrupted"); } };
      return new Response(archive);
    },
    wait: async milliseconds => { time += milliseconds; },
  });
  assert.deepEqual(bytes, archive);
  assert.equal(calls, 3);
  assert.deepEqual(allowances, [120_000, 109_000, 97_000]);
});

test("an expired transport deadline cannot open another request", async () => {
  let calls = 0;
  let time = 0;
  await assert.rejects(downloadPinnedHermesArchive(version, {
    now: () => time,
    request: async () => { calls++; time = 120_000; throw new TypeError("fetch failed"); },
    wait: async () => assert.fail("The expired download cannot retry"),
  }), /deadline exceeded/);
  assert.equal(calls, 1);
});
