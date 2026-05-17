import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentPolicyService,
  AgentRoutingService,
  DEFAULT_ORGANIZATION_AGENT_CONFIG,
  normalizeOrganizationAgentConfig,
  type PaperclipTask,
} from "../features/agents/index.js";

const scopedTask: PaperclipTask = {
  id: "PAP-1",
  type: "bugfix",
  source: "Paperclip",
  originalGoal: "Fix a focused UI typo.",
  approvedScope: "Change only the dashboard title typo.",
  allowedPaths: ["ui/src/pages/Dashboard.tsx"],
  reason: "Claude unavailable",
};

describe("agent routing service", () => {
  const routing = new AgentRoutingService();
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("selects Claude for missing config and dualMode=false by default", () => {
    expect(routing.resolve({ task: scopedTask, claudeStatus: "available" })).toBe("claude");
    expect(routing.resolve({
      task: scopedTask,
      organizationConfig: DEFAULT_ORGANIZATION_AGENT_CONFIG,
      claudeStatus: "available",
    })).toBe("claude");
  });

  it("normalizes invalid organization config to the Claude-first default", () => {
    expect(normalizeOrganizationAgentConfig({
      dualMode: true,
      primaryAgent: "codex",
      secondaryAgent: "codex",
    })).toEqual(DEFAULT_ORGANIZATION_AGENT_CONFIG);
    expect(normalizeOrganizationAgentConfig({
      dualMode: true,
      primaryAgent: "invalid" as "claude",
      secondaryAgent: "codex",
    })).toEqual({
      dualMode: true,
      primaryAgent: "claude",
      secondaryAgent: "codex",
    });
  });

  it("routes dual-mode primary and secondary agents by status", () => {
    expect(routing.resolve({
      task: scopedTask,
      organizationConfig: { dualMode: true, primaryAgent: "claude", secondaryAgent: "codex" },
      claudeStatus: "available",
      codexStatus: "available",
    })).toBe("claude");

    expect(routing.resolve({
      task: scopedTask,
      organizationConfig: { dualMode: true, primaryAgent: "claude", secondaryAgent: "codex" },
      claudeStatus: "unavailable",
      codexStatus: "available",
    })).toBe("codex");

    expect(routing.resolve({
      task: scopedTask,
      organizationConfig: { dualMode: true, primaryAgent: "codex", secondaryAgent: "claude" },
      claudeStatus: "available",
      codexStatus: "available",
    })).toBe("codex");

    expect(routing.resolve({
      task: scopedTask,
      organizationConfig: { dualMode: true, primaryAgent: "codex", secondaryAgent: "claude" },
      claudeStatus: "available",
      codexStatus: "unavailable",
    })).toBe("claude");
  });

  it("keeps default routing on the primary agent unless dual-mode is enabled", () => {
    expect(routing.resolve({ task: scopedTask, claudeStatus: "tokens_low" })).toBe("claude");
    expect(routing.resolve({ task: scopedTask, claudeStatus: "tokens_empty" })).toBe("claude");
    expect(routing.resolve({ task: scopedTask, claudeStatus: "rate_limited" })).toBe("claude");
    expect(routing.resolve({ task: scopedTask, claudeStatus: "unavailable" })).toBe("claude");
  });
});

describe("agent policy service", () => {
  const policy = new AgentPolicyService();
  let previousNodeEnv: string | undefined;

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  it("allows Claude execution without Codex restrictions", () => {
    expect(policy.validateExecution({ task: {}, agent: "claude" }).allowed).toBe(true);
  });

  it("rejects Codex outside development mode", () => {
    process.env.NODE_ENV = "production";

    const rejected = policy.validateExecution({
      task: scopedTask,
      agent: "codex",
      claudeStatus: "unavailable",
    });

    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toContain("only available in development mode");
  });

  it("allows scoped Codex fallback only when Claude fallback status permits it", () => {
    expect(policy.validateExecution({
      task: scopedTask,
      agent: "codex",
      claudeStatus: "unavailable",
    }).allowed).toBe(true);

    const rejected = policy.validateExecution({
      task: scopedTask,
      agent: "codex",
      claudeStatus: "available",
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toContain("Codex execution requires dual-mode routing");
  });

  it("rejects Codex for missing task metadata, allowed paths, and scope", () => {
    const rejected = policy.validateExecution({
      task: { reason: "Claude unavailable" },
      agent: "codex",
      claudeStatus: "unavailable",
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.validationResults).toEqual(expect.arrayContaining([
      "task has no ID",
      "task has no type",
      "task has no explicit scope",
      "task has no explicit allowed paths",
    ]));
  });

  it("rejects secrets, destructive commands, production deploys, and repo-wide scope", () => {
    const rejected = policy.validateExecution({
      task: {
        ...scopedTask,
        originalGoal: "Deploy production and refactor the whole repository.",
        approvedScope: "Change everything and read secrets.",
        allowedPaths: [".env"],
        requestedCommands: ["rm -rf node_modules"],
        requiresProductionDeployment: true,
      },
      agent: "codex",
      claudeStatus: "unavailable",
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.reason).toContain("production deployment");
    expect(rejected.reason).toContain("repository-wide");
    expect(rejected.reason).toContain("forbidden path");
    expect(rejected.reason).toContain("requested command is not allowed");
  });

  it("allows policy-validated Codex execution in dual-mode and blocks secrets paths", () => {
    const allowed = policy.validateExecution({
      task: {
        ...scopedTask,
        id: "PAP-2",
        source: "Paperclip",
        type: "bugfix",
        originalGoal: "Fix a focused UI typo.",
        approvedScope: "Change only the dashboard title typo.",
        allowedPaths: ["ui/src/pages/Dashboard.tsx"],
        reason: "Primary agent unavailable",
      },
      agent: "codex",
      claudeStatus: "unavailable",
      organizationConfig: { dualMode: true, primaryAgent: "claude", secondaryAgent: "codex" },
    });
    expect(allowed.allowed).toBe(true);

    const blocked = policy.validateExecution({
      task: {
        ...scopedTask,
        id: "PAP-3",
        originalGoal: "Read secret files.",
        approvedScope: "Read local secrets.",
        allowedPaths: [".env"],
        reason: "Primary agent unavailable",
      },
      agent: "codex",
      claudeStatus: "unavailable",
      organizationConfig: { dualMode: true, primaryAgent: "claude", secondaryAgent: "codex" },
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("forbidden path");
  });
});
