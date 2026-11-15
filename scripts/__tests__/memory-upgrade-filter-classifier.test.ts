import assert from "node:assert/strict";
import test from "node:test";
import {
  computeFilterPromptSha256,
  FILTER_DROP_REASONS,
  FILTER_KEEP_REASONS,
  FILTER_PROMPT_SHA256,
  validateFilterOutput,
} from "../../server/src/services/company-memory-upgrade/filter-contract.js";
import {
  OpenAiFilterClassifierClient,
} from "../../server/src/services/company-memory-upgrade/filter-classifier.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

test("Filter Classifier Contract and Retrying Client Tests", async (t) => {
  await t.test("prompt SHA-256 is deterministic and excludes duplicate_of_other_record", () => {
    const computed = computeFilterPromptSha256();
    assert.equal(computed, FILTER_PROMPT_SHA256);
    assert.equal((FILTER_DROP_REASONS as readonly string[]).includes("duplicate_of_other_record"), false);
  });

  await t.test("validateFilterOutput accepts all valid keep and drop pairings", () => {
    for (const reason of FILTER_KEEP_REASONS) {
      const res = validateFilterOutput({ decision: "keep", reason });
      assert.equal(res.decision, "keep");
      assert.equal(res.reason, reason);
    }

    for (const reason of FILTER_DROP_REASONS) {
      const res = validateFilterOutput({ decision: "drop", reason });
      assert.equal(res.decision, "drop");
      assert.equal(res.reason, reason);
    }
  });

  await t.test("recovers from 429 rate limit then succeeds", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ decision: "keep", reason: "durable_fact" }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      );
    };

    const client = new OpenAiFilterClassifierClient({
      apiKey: "sk-fake-test-key",
      fetchFn: fakeFetch,
      sleeper: { sleep: async () => {} },
    });

    const res = await client.classify("memory text", "key-429");
    assert.equal(res.decision, "keep");
    assert.equal(res.reason, "durable_fact");
    assert.equal(callCount, 2);
  });

  await t.test("terminal 401 fails closed promptly without retry naming import_key", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new OpenAiFilterClassifierClient({
      apiKey: "sk-fake-test-key",
      fetchFn: fakeFetch,
    });

    await assert.rejects(
      async () => client.classify("memory text", "key-401-terminal"),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.message.includes("401") &&
        err.message.includes("key-401-terminal"),
    );
    assert.equal(callCount, 1);
  });

  await t.test("recovers from timeout then succeeds", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async (_url, init) => {
      callCount++;
      if (callCount === 1) {
        // Wait until timeoutController aborts init.signal
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("The operation was aborted");
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ decision: "drop", reason: "run_status" }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 },
      );
    };

    const client = new OpenAiFilterClassifierClient({
      apiKey: "sk-fake-test-key",
      fetchFn: fakeFetch,
      timeoutMs: 10,
      sleeper: { sleep: async () => {} },
    });

    const res = await client.classify("memory text", "key-timeout");
    assert.equal(res.decision, "drop");
    assert.equal(res.reason, "run_status");
    assert.equal(callCount, 2);
  });

  await t.test("retry exhaustion fails closed naming import_key", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response("Service Unavailable", { status: 503 });
    };

    const client = new OpenAiFilterClassifierClient({
      apiKey: "sk-fake-test-key",
      fetchFn: fakeFetch,
      maxAttempts: 3,
      sleeper: { sleep: async () => {} },
    });

    await assert.rejects(
      async () => client.classify("memory text", "key-exhaustion-503"),
      (err: any) =>
        err instanceof CompanyMemoryUpgradeError &&
        err.message.includes("after 3 attempts") &&
        err.message.includes("key-exhaustion-503"),
    );
    assert.equal(callCount, 3);
  });
});
