import { describe, expect, it, vi } from "vitest";
import {
  buildExecutionConfigForAdapter,
  getQuotaBlockReason,
  resolveHeartbeatAdapterExecution,
  synthesizeExecutionRuntimeConfig,
} from "../services/adapter-fallback.ts";

describe("adapter fallback quota helpers", () => {
  it("treats a fully used future-reset window as blocked", () => {
    const reason = getQuotaBlockReason(
      {
        provider: "anthropic",
        ok: true,
        windows: [
          {
            label: "Current week (Sonnet only)",
            usedPercent: 100,
            resetsAt: "2026-03-31T18:00:00.000Z",
            valueLabel: null,
            detail: null,
          },
        ],
      },
      new Date("2026-03-30T18:00:00.000Z"),
    );

    expect(reason).toContain("Current week (Sonnet only)");
    expect(reason).toContain("2026-03-31T18:00:00.000Z");
  });

  it("ignores fully used windows that already reset", () => {
    const reason = getQuotaBlockReason(
      {
        provider: "anthropic",
        ok: true,
        windows: [
          {
            label: "Current week (Sonnet only)",
            usedPercent: 100,
            resetsAt: "2026-03-29T18:00:00.000Z",
            valueLabel: null,
            detail: null,
          },
        ],
      },
      new Date("2026-03-30T18:00:00.000Z"),
    );

    expect(reason).toBeNull();
  });
});

describe("execution policy synthesis", () => {
  it("synthesizes a provider-neutral execution profile and policy for local model adapters", () => {
    const runtimeConfig = synthesizeExecutionRuntimeConfig({
      adapterType: "claude_local",
      adapterConfig: {
        cwd: "/tmp/project",
        instructionsFilePath: "/tmp/project/AGENTS.md",
        promptTemplate: "Continue your Paperclip work.",
        timeoutSec: 1200,
        env: { PAPERCLIP_FOO: "bar" },
      },
      runtimeConfig: {},
    });

    expect(runtimeConfig).toMatchObject({
      executionProfile: {
        cwd: "/tmp/project",
        instructionsFilePath: "/tmp/project/AGENTS.md",
        promptTemplate: "Continue your Paperclip work.",
        timeoutSec: 1200,
        env: { PAPERCLIP_FOO: "bar" },
      },
      executionPolicy: {
        mode: "prefer_available",
        compatibleAdapterTypes: expect.arrayContaining(["claude_local", "codex_local"]),
        preferredAdapterTypes: expect.arrayContaining(["claude_local", "codex_local"]),
      },
    });
  });

  it("keeps Hermes runtime defaults on Hermes and Codex only", () => {
    const runtimeConfig = synthesizeExecutionRuntimeConfig({
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
      },
      runtimeConfig: {},
    });

    expect(runtimeConfig).toMatchObject({
      executionPolicy: {
        mode: "prefer_available",
        compatibleAdapterTypes: ["hermes_local", "codex_local"],
        preferredAdapterTypes: ["hermes_local", "codex_local"],
      },
    });
  });
});

describe("buildExecutionConfigForAdapter", () => {
  it("maps provider-neutral issue overrides into the selected adapter config", () => {
    const config = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "codex_local",
      adapterConfig: {
        cwd: "/tmp/project",
        promptTemplate: "Continue your Paperclip work.",
      },
      runtimeConfig: {
        executionProfile: {
          instructionsFilePath: "/tmp/project/AGENTS.md",
        },
      },
      issueExecutionOverrides: {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
        perAdapterConfig: {
          codex_local: {
            search: true,
          },
        },
      },
    });

    expect(config).toEqual({
      cwd: "/tmp/project",
      promptTemplate: "Continue your Paperclip work.",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      search: true,
    });
  });

  it("sanitizes Claude-only fields when building a Codex fallback config", () => {
    const config = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "codex_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
        dangerouslySkipPermissions: true,
      },
      runtimeConfig: {
        executionPolicy: {
          preferredAdapterTypes: ["claude_local", "codex_local"],
          perAdapterConfig: {
            codex_local: {
              model: "gpt-5.4-mini",
              dangerouslySkipPermissions: true,
              dangerouslyBypassApprovalsAndSandbox: true,
              search: true,
            },
          },
        },
      },
    });

    expect(config).toEqual({
      cwd: "/tmp/project",
      model: "gpt-5.4-mini",
      dangerouslyBypassApprovalsAndSandbox: true,
      search: true,
    });
  });

  it("drops invalid OpenCode model strings instead of carrying adapter-incompatible values", () => {
    const config = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
      },
      runtimeConfig: {
        executionPolicy: {
          preferredAdapterTypes: ["claude_local", "opencode_local"],
          perAdapterConfig: {
            opencode_local: {
              model: "minimax-m2.5-free",
              timeoutSec: 1800,
              dangerouslySkipPermissions: true,
            },
          },
        },
      },
    });

    expect(config).toEqual({
      cwd: "/tmp/project",
      timeoutSec: 1800,
    });
  });

  it("drops Codex-style model ids instead of carrying them into Hermes execution", () => {
    const config = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
      },
      runtimeConfig: {
        executionPolicy: {
          preferredAdapterTypes: ["claude_local", "hermes_local", "codex_local"],
          perAdapterConfig: {
            hermes_local: {
              model: "gpt-5.4-mini",
              provider: "copilot",
              timeoutSec: 1800,
            },
          },
        },
      },
    });

    expect(config).toEqual({
      cwd: "/tmp/project",
      provider: "copilot",
      timeoutSec: 1800,
    });
  });

  it("keeps direct DeepSeek model ids in Anthropic-compatible Hermes configs", () => {
    const config = buildExecutionConfigForAdapter({
      agentAdapterType: "hermes_local",
      executionAdapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
        provider: "anthropic",
        model: "deepseek-v4-flash",
        blueprintHermesModelLadder: [
          "deepseek-v4-flash",
          "deepseek-v4-pro[1m]",
        ],
        env: {
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
        },
        timeoutSec: 1800,
      },
      runtimeConfig: {},
    });

    expect(config).toMatchObject({
      cwd: "/tmp/project",
      provider: "anthropic",
      model: "deepseek-v4-flash",
      blueprintHermesModelLadder: [
        "deepseek-v4-flash",
        "deepseek-v4-pro[1m]",
      ],
      env: {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      },
      timeoutSec: 1800,
    });
  });

  it("keeps generic provider/model ids for Hermes", () => {
    const config = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "hermes_local",
      adapterConfig: {
        cwd: "/tmp/project",
      },
      runtimeConfig: {
        executionPolicy: {
          preferredAdapterTypes: ["hermes_local"],
          perAdapterConfig: {
            hermes_local: {
              model: "z-ai/glm-5.1",
              provider: "openrouter",
            },
          },
        },
      },
    });

    expect(config).toMatchObject({
      cwd: "/tmp/project",
      provider: "openrouter",
      model: "z-ai/glm-5.1",
    });
  });

  it("does not leak a Claude issue-level model override into Codex or OpenCode fallbacks", () => {
    const codexConfig = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "codex_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
      },
      runtimeConfig: {
        executionPolicy: {
          preferredAdapterTypes: ["claude_local", "codex_local", "opencode_local"],
          perAdapterConfig: {
            codex_local: {
              model: "gpt-5.4-mini",
            },
            opencode_local: {
              model: "opencode/minimax-m2.5-free",
            },
          },
        },
      },
      issueExecutionOverrides: {
        model: "claude-sonnet-4-6",
      },
    });

    const opencodeConfig = buildExecutionConfigForAdapter({
      agentAdapterType: "claude_local",
      executionAdapterType: "opencode_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
      },
      runtimeConfig: {
        executionPolicy: {
          preferredAdapterTypes: ["claude_local", "codex_local", "opencode_local"],
          perAdapterConfig: {
            codex_local: {
              model: "gpt-5.4-mini",
            },
            opencode_local: {
              model: "opencode/minimax-m2.5-free",
            },
          },
        },
      },
      issueExecutionOverrides: {
        model: "claude-sonnet-4-6",
      },
    });

    expect(codexConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "gpt-5.4-mini",
    });
    expect(opencodeConfig).toMatchObject({
      cwd: "/tmp/project",
      model: "opencode/minimax-m2.5-free",
    });
  });
});

describe("resolveHeartbeatAdapterExecution", () => {
  it("keeps fixed adapters on their configured runtime when available", async () => {
    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-1",
      primaryAdapterType: "process",
      adapterConfig: { command: "bash" },
      runtimeConfig: {},
      getQuotaWindows: vi.fn(async () => null),
      testEnvironment: vi.fn(async () => ({
        adapterType: "process",
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      })),
    });

    expect(result.action).toBe("run");
    if (result.action !== "run") {
      throw new Error("expected run action");
    }
    expect(result.adapterType).toBe("process");
    expect(result.config.command).toBe("bash");
  });

  it("switches to Codex when the primary Claude adapter is quota-blocked", async () => {
    const getQuotaWindows = vi.fn(async (adapterType: string) => {
      if (adapterType === "claude_local") {
        return {
          provider: "anthropic",
          ok: true,
          windows: [
            {
              label: "Current week (Sonnet only)",
              usedPercent: 100,
              resetsAt: "2026-03-31T18:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
          ],
        };
      }
      if (adapterType === "codex_local") {
        return {
          provider: "openai",
          ok: true,
          windows: [
            {
              label: "5h",
              usedPercent: 12,
              resetsAt: "2026-03-30T20:00:00.000Z",
              valueLabel: null,
              detail: null,
            },
          ],
        };
      }
      return null;
    });

    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-1",
      primaryAdapterType: "claude_local",
      adapterConfig: {
        cwd: "/tmp/project",
        promptTemplate: "Continue your Paperclip work.",
        instructionsFilePath: "/tmp/project/AGENTS.md",
      },
      runtimeConfig: {},
      issueExecutionOverrides: {
        reasoningEffort: "high",
      },
      getQuotaWindows,
      testEnvironment: vi.fn(async () => null),
      now: new Date("2026-03-30T18:00:00.000Z"),
    });

    expect(result.action).toBe("run");
    if (result.action !== "run") {
      throw new Error("expected run action");
    }
    expect(result.adapterType).toBe("codex_local");
    expect(result.config).toMatchObject({
      cwd: "/tmp/project",
      promptTemplate: "Continue your Paperclip work.",
      instructionsFilePath: "/tmp/project/AGENTS.md",
      modelReasoningEffort: "high",
    });
    expect(result.diagnostics[0]).toEqual({
      adapterType: "claude_local",
      available: false,
      reason: "Current week (Sonnet only) exhausted until 2026-03-31T18:00:00.000Z",
    });
  });

  it("blocks the run when no compatible adapter is available", async () => {
    const getQuotaWindows = vi.fn(async (adapterType: string) => {
      if (adapterType === "claude_local") {
        return {
          provider: "anthropic",
          ok: false,
          error: "no local claude auth token",
          windows: [],
        };
      }
      if (adapterType === "codex_local") {
        return {
          provider: "openai",
          ok: false,
          error: "no local codex auth token",
          windows: [],
        };
      }
      return null;
    });

    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-1",
      primaryAdapterType: "claude_local",
      adapterConfig: { cwd: "/tmp/project" },
      runtimeConfig: {},
      getQuotaWindows,
      testEnvironment: vi.fn(async () => ({
        adapterType: "claude_local",
        status: "fail",
        checks: [
          {
            code: "auth_required",
            level: "error",
            message: "login is required",
          },
        ],
        testedAt: new Date().toISOString(),
      })),
      now: new Date("2026-03-30T18:00:00.000Z"),
    });

    expect(result.action).toBe("block");
    if (result.action !== "block") {
      throw new Error("expected block action");
    }
    expect(result.reason).toContain("claude_local");
  });

  it("keeps environment failure details in block reasons", async () => {
    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-env-detail",
      primaryAdapterType: "codex_local",
      adapterConfig: { cwd: "/tmp/codex-usage-limit-project" },
      runtimeConfig: {
        executionPolicy: {
          mode: "fixed",
          preferredAdapterTypes: ["codex_local"],
          compatibleAdapterTypes: ["codex_local"],
        },
      },
      getQuotaWindows: vi.fn(async () => null),
      testEnvironment: vi.fn(async () => ({
        adapterType: "codex_local",
        status: "fail",
        checks: [
          {
            code: "codex_hello_probe_failed",
            level: "error",
            message: "Codex hello probe failed.",
            detail:
              "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 11th, 2026 10:34 PM.",
          },
        ],
        testedAt: new Date().toISOString(),
      })),
      now: new Date("2026-05-10T16:00:00.000Z"),
    });

    expect(result.action).toBe("block");
    if (result.action !== "block") {
      throw new Error("expected block action");
    }
    expect(result.reason).toContain("codex_local:");
    expect(result.reason).toContain("Codex hello probe failed.");
    expect(result.reason).toContain("chatgpt.com/codex/settings/usage");
  });

  it("uses explicit Claude-lane policy to prefer Hermes before OpenCode and Codex", async () => {
    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-1",
      primaryAdapterType: "claude_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
      },
      runtimeConfig: {
        executionPolicy: {
          mode: "prefer_available",
          compatibleAdapterTypes: ["claude_local", "hermes_local", "opencode_local", "codex_local"],
          preferredAdapterTypes: ["claude_local", "hermes_local", "opencode_local", "codex_local"],
          perAdapterConfig: {
            hermes_local: {
              cwd: "/tmp/project",
              model: "qwen/qwen3.6-plus-preview:free",
              timeoutSec: 1800,
            },
            opencode_local: {
              cwd: "/tmp/project",
              model: "opencode/minimax-m2.5-free",
              timeoutSec: 1800,
            },
            codex_local: {
              cwd: "/tmp/project",
              model: "gpt-5.4-mini",
              modelReasoningEffort: "high",
              dangerouslyBypassApprovalsAndSandbox: true,
            },
          },
        },
      },
      getQuotaWindows: vi.fn(async (adapterType: string) => {
        if (adapterType === "claude_local") {
          return {
            provider: "anthropic",
            ok: true,
            windows: [
              {
                label: "Current week (Sonnet only)",
                usedPercent: 100,
                resetsAt: "2026-03-31T18:00:00.000Z",
                valueLabel: null,
                detail: null,
              },
            ],
          };
        }
        return null;
      }),
      testEnvironment: vi.fn(async (adapterType: string) => {
        if (adapterType === "hermes_local") {
          return {
            adapterType,
            status: "pass",
            checks: [],
            testedAt: new Date().toISOString(),
          };
        }
        return null;
      }),
      now: new Date("2026-03-30T18:00:00.000Z"),
    });

    expect(result.action).toBe("run");
    if (result.action !== "run") {
      throw new Error("expected run action");
    }
    expect(result.adapterType).toBe("hermes_local");
    expect(result.config).toMatchObject({
      cwd: "/tmp/project",
      model: "qwen/qwen3.6-plus-preview:free",
      timeoutSec: 1800,
    });
  });

  it("uses explicit Claude-lane policy to fall through to OpenCode when Hermes is unavailable", async () => {
    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-2",
      primaryAdapterType: "claude_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "claude-sonnet-4-6",
      },
      runtimeConfig: {
        executionPolicy: {
          mode: "prefer_available",
          compatibleAdapterTypes: ["claude_local", "hermes_local", "opencode_local", "codex_local"],
          preferredAdapterTypes: ["claude_local", "hermes_local", "opencode_local", "codex_local"],
          perAdapterConfig: {
            hermes_local: {
              cwd: "/tmp/project",
              model: "qwen/qwen3.6-plus-preview:free",
              timeoutSec: 1800,
            },
            opencode_local: {
              cwd: "/tmp/project",
              model: "opencode/minimax-m2.5-free",
              timeoutSec: 1800,
            },
          },
        },
      },
      getQuotaWindows: vi.fn(async (adapterType: string) => {
        if (adapterType === "claude_local") {
          return {
            provider: "anthropic",
            ok: true,
            windows: [
              {
                label: "Current week (Sonnet only)",
                usedPercent: 100,
                resetsAt: "2026-03-31T18:00:00.000Z",
                valueLabel: null,
                detail: null,
              },
            ],
          };
        }
        return null;
      }),
      testEnvironment: vi.fn(async (adapterType: string) => {
        if (adapterType === "hermes_local") {
          return {
            adapterType,
            status: "fail",
            checks: [
              {
                code: "auth_required",
                level: "error",
                message: "login is required",
              },
            ],
            testedAt: new Date().toISOString(),
          };
        }
        if (adapterType === "opencode_local") {
          return {
            adapterType,
            status: "pass",
            checks: [],
            testedAt: new Date().toISOString(),
          };
        }
        return null;
      }),
      now: new Date("2026-03-30T18:00:00.000Z"),
    });

    expect(result.action).toBe("run");
    if (result.action !== "run") {
      throw new Error("expected run action");
    }
    expect(result.adapterType).toBe("opencode_local");
    expect(result.config).toMatchObject({
      cwd: "/tmp/project",
      model: "opencode/minimax-m2.5-free",
      timeoutSec: 1800,
    });
  });

  it("probes the primary adapter first even when runtime policy order is stale", async () => {
    const testEnvironment = vi.fn(async (adapterType: string) => {
      if (adapterType === "codex_local") {
        return {
          adapterType,
          status: "pass",
          checks: [],
          testedAt: new Date().toISOString(),
        };
      }
      return {
        adapterType,
        status: "fail",
        checks: [
          {
            code: "auth_required",
            level: "error",
            message: "Claude login is required.",
          },
        ],
        testedAt: new Date().toISOString(),
      };
    });

    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-3",
      primaryAdapterType: "codex_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "gpt-5.4-mini",
        modelReasoningEffort: "xhigh",
      },
      runtimeConfig: {
        executionPolicy: {
          mode: "prefer_available",
          preferredAdapterTypes: ["claude_local", "hermes_local", "opencode_local", "codex_local"],
          compatibleAdapterTypes: ["claude_local", "hermes_local", "opencode_local", "codex_local"],
        },
      },
      getQuotaWindows: vi.fn(async () => null),
      testEnvironment,
    });

    expect(result.action).toBe("run");
    if (result.action !== "run") {
      throw new Error("expected run action");
    }
    expect(result.adapterType).toBe("codex_local");
    expect(testEnvironment).toHaveBeenCalledTimes(1);
    expect(testEnvironment).toHaveBeenCalledWith(
      "codex_local",
      expect.objectContaining({
        cwd: "/tmp/project",
        model: "gpt-5.4-mini",
      }),
    );
  });

  it("includes the actual primary probe failure reason in fallback messages", async () => {
    const result = await resolveHeartbeatAdapterExecution({
      companyId: "company-4",
      primaryAdapterType: "codex_local",
      adapterConfig: {
        cwd: "/tmp/project",
        model: "gpt-5.4-mini",
      },
      runtimeConfig: {
        executionPolicy: {
          mode: "prefer_available",
          preferredAdapterTypes: ["claude_local", "codex_local"],
          compatibleAdapterTypes: ["claude_local", "codex_local"],
          perAdapterConfig: {
            claude_local: {
              cwd: "/tmp/project",
              model: "claude-sonnet-4-6",
              dangerouslySkipPermissions: true,
            },
          },
        },
      },
      getQuotaWindows: vi.fn(async () => null),
      testEnvironment: vi.fn(async (adapterType: string) => {
        if (adapterType === "codex_local") {
          return {
            adapterType,
            status: "fail",
            checks: [
              {
                code: "auth_required",
                level: "error",
                message: "Codex login is required.",
              },
            ],
            testedAt: new Date().toISOString(),
          };
        }
        return {
          adapterType,
          status: "pass",
          checks: [],
          testedAt: new Date().toISOString(),
        };
      }),
    });

    expect(result.action).toBe("run");
    if (result.action !== "run") {
      throw new Error("expected run action");
    }
    expect(result.adapterType).toBe("claude_local");
    expect(result.reason).toContain("codex_local was unavailable");
    expect(result.reason).toContain("Codex login is required.");
  });
});
