import { describe, expect, it, vi } from "vitest";
import {
  buildAdapterFailoverPlan,
  executeWithAdapterFailover,
  isRetryableAdapterFailure,
} from "../services/adapter-failover.js";

describe("adapter failover", () => {
  it("treats quota and rate-limit failures as retryable", () => {
    expect(isRetryableAdapterFailure({
      timedOut: false,
      errorCode: "quota_exhausted",
      errorMessage: "429 RESOURCE_EXHAUSTED",
    })).toBe(true);

    expect(isRetryableAdapterFailure({
      timedOut: false,
      errorCode: "model_access_denied",
      errorMessage: "model access denied",
    })).toBe(false);
  });

  it("builds a primary plus backup plan across adapter model catalogs", async () => {
    const resolution = await buildAdapterFailoverPlan({
      primaryAdapterType: "claude_local",
      runtimeConfig: {
        model: "claude-opus-4-6",
        failoverModels: [
          "claude-sonnet-4-6",
          "gpt-5.4",
          "missing-model",
        ],
      },
      resolveModels: async (adapterType) => {
        if (adapterType === "claude_local") {
          return [
            { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
            { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          ];
        }
        if (adapterType === "codex_local") {
          return [{ id: "gpt-5.4", label: "GPT-5.4" }];
        }
        return [];
      },
      listAdapterTypes: () => ["claude_local", "codex_local"],
    });

    expect(resolution.attempts).toEqual([
      expect.objectContaining({
        adapterType: "claude_local",
        model: "claude-opus-4-6",
        usesFailover: false,
      }),
      expect.objectContaining({
        adapterType: "claude_local",
        model: "claude-sonnet-4-6",
        usesFailover: true,
      }),
      expect.objectContaining({
        adapterType: "codex_local",
        model: "gpt-5.4",
        usesFailover: true,
      }),
    ]);
    expect(resolution.warnings).toEqual([
      'No adapter model catalog matched failover model "missing-model".',
    ]);
  });

  it("falls through retryable failures until a backup succeeds", async () => {
    const onFailover = vi.fn();
    const execution = await executeWithAdapterFailover({
      attempts: [
        {
          adapterType: "claude_local",
          model: "claude-opus-4-6",
          config: { model: "claude-opus-4-6" },
          usesFailover: false,
        },
        {
          adapterType: "codex_local",
          model: "gpt-5.4",
          config: { model: "gpt-5.4" },
          usesFailover: true,
        },
      ],
      executeAttempt: async (attempt) => {
        if (attempt.adapterType === "claude_local") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "quota_exhausted",
            errorMessage: "429 RESOURCE_EXHAUSTED",
          };
        }

        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          model: "gpt-5.4",
        };
      },
      onFailover,
    });

    expect(execution.attempt.adapterType).toBe("codex_local");
    expect(execution.result.exitCode).toBe(0);
    expect(onFailover).toHaveBeenCalledTimes(1);
  });
});
