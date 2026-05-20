import { describe, expect, it } from "vitest";

import { buildRoutingOverrideEnv } from "../routing/build-routing-override-env.js";

describe("buildRoutingOverrideEnv (Phase E1 dispatch wrap)", () => {
  describe("env key shape (Patch 5.1 contract)", () => {
    it("sets HERMES_MODEL_OVERRIDE + HERMES_PROVIDER_OVERRIDE as typed-env wrappers", () => {
      const { env } = buildRoutingOverrideEnv({
        issueComplexity: "trivial",
        agentTierPreference: "default",
      });
      // Patch 5.1's _unwrapTypedEnv reads `.value` from this shape and
      // also tolerates a plain string. We standardize on the typed shape
      // so spawn-env merge (Patch 1) and override read (Patch 5.1) both
      // see the same wrapper.
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-haiku-4-5-20251001",
      });
      expect(env.HERMES_PROVIDER_OVERRIDE).toEqual({
        type: "plain",
        value: "anthropic",
      });
    });

    it("issue complexity wins over agent preference (operator intent is canonical)", () => {
      const { resolution, env } = buildRoutingOverrideEnv({
        issueComplexity: "hard",
        agentTierPreference: "fast",
      });
      expect(resolution.tier).toBe("heavy");
      expect(resolution.source).toBe("issue_complexity");
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-opus-4-7",
      });
    });

    it("normal complexity falls through to agent.tierPreference", () => {
      const { resolution, env } = buildRoutingOverrideEnv({
        issueComplexity: "normal",
        agentTierPreference: "heavy",
      });
      expect(resolution.tier).toBe("heavy");
      expect(resolution.source).toBe("agent_preference");
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-opus-4-7",
      });
    });

    it("missing both complexity and agent preference falls back to default tier", () => {
      const { resolution, env } = buildRoutingOverrideEnv({});
      expect(resolution.tier).toBe("default");
      expect(resolution.source).toBe("default");
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-sonnet-4-6",
      });
    });

    it("local complexity routes to ollama provider", () => {
      const { resolution, env } = buildRoutingOverrideEnv({
        issueComplexity: "local",
      });
      expect(resolution.tier).toBe("local");
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "qwen2.5-coder:7b",
      });
      expect(env.HERMES_PROVIDER_OVERRIDE).toEqual({
        type: "plain",
        value: "ollama",
      });
    });
  });

  describe("existing env preservation (must not lose API keys)", () => {
    it("preserves ANTHROPIC_API_KEY and HERMES_YOLO_MODE alongside the override", () => {
      // These two keys are load-bearing on the pilot agent — losing
      // ANTHROPIC_API_KEY would re-introduce the 401 bug class; losing
      // HERMES_YOLO_MODE would break the approval-gate bypass.
      const existingEnv: Record<string, unknown> = {
        ANTHROPIC_API_KEY: { type: "secret", secretId: "pilot-anthropic" },
        HERMES_YOLO_MODE: { type: "plain", value: "1" },
        ARBITRARY_OPERATOR_KEY: { type: "plain", value: "abc" },
      };
      const { env } = buildRoutingOverrideEnv({
        issueComplexity: "trivial",
        existingEnv,
      });
      expect(env.ANTHROPIC_API_KEY).toEqual(existingEnv.ANTHROPIC_API_KEY);
      expect(env.HERMES_YOLO_MODE).toEqual(existingEnv.HERMES_YOLO_MODE);
      expect(env.ARBITRARY_OPERATOR_KEY).toEqual(existingEnv.ARBITRARY_OPERATOR_KEY);
      // And the override is still applied.
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-haiku-4-5-20251001",
      });
    });

    it("resolver-driven values override any pre-existing HERMES_*_OVERRIDE in the env", () => {
      // If the agent record happens to carry stale HERMES_MODEL_OVERRIDE
      // (e.g. residue from a manual verify-routing-overrides.py run),
      // the dispatch resolver decision must win for the current call.
      const existingEnv: Record<string, unknown> = {
        HERMES_MODEL_OVERRIDE: { type: "plain", value: "stale-value" },
        HERMES_PROVIDER_OVERRIDE: { type: "plain", value: "stale-provider" },
      };
      const { env } = buildRoutingOverrideEnv({
        issueComplexity: "hard",
        existingEnv,
      });
      expect(env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-opus-4-7",
      });
      expect(env.HERMES_PROVIDER_OVERRIDE).toEqual({
        type: "plain",
        value: "anthropic",
      });
    });

    it("null/undefined existingEnv is treated as empty", () => {
      const { env: a } = buildRoutingOverrideEnv({
        issueComplexity: "trivial",
        existingEnv: null,
      });
      const { env: b } = buildRoutingOverrideEnv({
        issueComplexity: "trivial",
      });
      expect(Object.keys(a).sort()).toEqual([
        "HERMES_MODEL_OVERRIDE",
        "HERMES_PROVIDER_OVERRIDE",
      ]);
      expect(Object.keys(b).sort()).toEqual([
        "HERMES_MODEL_OVERRIDE",
        "HERMES_PROVIDER_OVERRIDE",
      ]);
    });
  });

  describe("dispatch integration shape (what heartbeat.ts will substitute onto agent.adapterConfig.env)", () => {
    it("returns both the resolution (for run-record persistence) and the wrapped env (for adapter)", () => {
      // The heartbeat dispatcher reads resolution.tier + resolution.entry.model
      // into heartbeat_runs.tier_chosen + heartbeat_runs.model_used, and
      // builds a wrappedAgent whose adapterConfig.env is the returned
      // env (deployed Patch 5.1 reads ctx.agent.adapterConfig.env, not
      // ctx.config.env). Both fields must be present on the single call.
      const result = buildRoutingOverrideEnv({
        issueComplexity: "trivial",
        agentTierPreference: "default",
        existingEnv: { ANTHROPIC_API_KEY: { type: "plain", value: "x" } },
      });
      expect(result.resolution.tier).toBe("fast");
      expect(result.resolution.entry.model).toBe("claude-haiku-4-5-20251001");
      expect(result.resolution.entry.provider).toBe("anthropic");
      expect(result.env.ANTHROPIC_API_KEY).toEqual({ type: "plain", value: "x" });
      expect(result.env.HERMES_MODEL_OVERRIDE).toEqual({
        type: "plain",
        value: "claude-haiku-4-5-20251001",
      });
    });
  });
});
