import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCommit, verifyDeployment } from "./verify-deployment.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

describe("deployment verification", () => {
  it("accepts only full commits", () => {
    assert.equal(normalizeCommit(` ${commit.toUpperCase()}\n`), commit);
    assert.equal(normalizeCommit("abcdef0"), null);
  });

  it("waits for a ready page whose health commit matches", async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      if (url.endsWith("/api/health")) {
        return new Response(JSON.stringify({
          status: "ok",
          bootstrapStatus: calls < 3 ? "bootstrap_pending" : "ready",
          commit: calls < 3 ? null : commit,
        }), { status: 200 });
      }
      return new Response("<html>ready</html>", { status: 200 });
    };
    let clock = 0;
    const evidence = await verifyDeployment({
      baseUrl: "https://paper-dev.example",
      expectedCommit: commit,
      timeoutMs: 100,
      pollMs: 1,
      fetchImpl,
      now: () => clock,
      sleepImpl: async () => { clock += 1; },
      log: () => {},
    });
    assert.equal(evidence.healthCommit, commit);
    assert.equal(calls, 4);
  });

  it("fails on a stale or unmarked revision", async () => {
    const fetchImpl = async (url) => url.endsWith("/api/health")
      ? new Response(JSON.stringify({ status: "ok", bootstrapStatus: "ready", commit: null }), { status: 200 })
      : new Response("<html>ready</html>", { status: 200 });
    await assert.rejects(verifyDeployment({
      baseUrl: "https://paper.example",
      expectedCommit: commit,
      timeoutMs: 1,
      pollMs: 0,
      fetchImpl,
      sleepImpl: async () => {},
      log: () => {},
    }), /expected=/);
  });
});
