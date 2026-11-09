import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeWithLLM, buildPrompt } from "./image-bloat-llm.mjs";

// The LLM pass reads a few env vars (key + explicit endpoint). Save/restore
// around each case so the endpoint-explicit contract is testable in isolation.
const ENV_KEYS = ["IMAGE_BLOAT_LLM_KEY", "LITELLM_KEY_PI", "LITELLM_BASE_URL", "IMAGE_BLOAT_LLM_MODEL"];

function withEnv(vars, fn) {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

describe("image-bloat-llm endpoint-explicit advisory pass", () => {
  it("skips with a note when no gateway key is configured", async () => {
    await withEnv({}, async () => {
      const result = await analyzeWithLLM({ detectorReport: "{}" });
      assert.equal(result.skipped, true);
      assert.match(result.note, /no LiteLLM key/i);
    });
  });

  it("skips with a note when a key exists but no LITELLM_BASE_URL is named (no third-party default)", async () => {
    await withEnv({ IMAGE_BLOAT_LLM_KEY: "sk-test" }, async () => {
      // A fetchImpl that throws if reached proves nothing is sent by default.
      const fetchImpl = async () => {
        throw new Error("fetch should not be called without an explicit endpoint");
      };
      const result = await analyzeWithLLM({ detectorReport: "{}", fetchImpl });
      assert.equal(result.skipped, true);
      assert.match(result.note, /LITELLM_BASE_URL/i);
    });
  });

  it("sends the diffs only to the explicitly named gateway and returns the model text", async () => {
    await withEnv(
      {
        IMAGE_BLOAT_LLM_KEY: "sk-test",
        LITELLM_BASE_URL: "https://gateway.example.svc/v1/",
        IMAGE_BLOAT_LLM_MODEL: "some-model",
      },
      async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
          calls.push({ url, init });
          return {
            ok: true,
            json: async () => ({ choices: [{ message: { content: "looks fine" } }] }),
          };
        };
        const result = await analyzeWithLLM(
          { detectorReport: '{"totalSizeBytes":1}', dockerfileDiff: "+FROM x", fetchImpl },
        );
        assert.equal(result.skipped, false);
        assert.equal(result.model, "some-model");
        assert.equal(result.text, "looks fine");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://gateway.example.svc/v1/chat/completions");
        assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
      },
    );
  });

  it("buildPrompt embeds the supplied diffs and the detector report", () => {
    const prompt = buildPrompt({
      dockerfileDiff: "+COPY server/dist /app/server/dist",
      lockfileDiff: "+  @openai/codex",
      detectorReport: '{"duplicatePackagesAcrossTrees":[]}',
    });
    assert.match(prompt, /COPY server\/dist/);
    assert.match(prompt, /@openai\/codex/);
    assert.match(prompt, /duplicatePackagesAcrossTrees/);
  });
});
