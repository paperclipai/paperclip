import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildKimiAcpConfig,
  nodeVersionMeetsKimiAcpMinimum,
  resolveKimiExecutionEngine,
  resolveKimiExecutionEngineForRun,
} from "./acp.js";

describe("resolveKimiExecutionEngineForRun on Windows", () => {
  it("uses the configured PATHEXT to find the command on the configured PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kimi-acp-pathext-"));
    const bin = path.join(root, "bin");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "kimi.ACP"), "", "utf8");
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      await expect(
        resolveKimiExecutionEngineForRun({
          config: { env: { PATH: bin, PATHEXT: ".ACP" } },
          executionTarget: null,
        }),
      ).resolves.toEqual({ engine: "acp", explicit: false });
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveKimiExecutionEngine", () => {
  it("defaults to ACP (non-explicit) when engine is unset", () => {
    expect(resolveKimiExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
  });

  it("honors an explicit engine=acp", () => {
    expect(resolveKimiExecutionEngine({ engine: "acp" })).toEqual({ engine: "acp", explicit: true });
  });

  it("honors an explicit engine=cli", () => {
    expect(resolveKimiExecutionEngine({ engine: "CLI" })).toEqual({ engine: "cli", explicit: true });
  });

  it("treats unknown values as the non-explicit ACP default", () => {
    expect(resolveKimiExecutionEngine({ engine: "nonsense" })).toEqual({ engine: "acp", explicit: false });
  });
});

describe("buildKimiAcpConfig", () => {
  it("targets the kimi agent and derives the `kimi acp` server command from `command`", () => {
    const out = buildKimiAcpConfig({ command: "kimi", cwd: "/work" });
    expect(out.agent).toBe("kimi");
    expect(out.agentCommand).toBe("kimi acp");
    expect(out.mode).toBe("persistent");
    expect(out.cwd).toBe("/work");
  });

  it("prefers an explicit agentCommand override", () => {
    const out = buildKimiAcpConfig({ command: "kimi", agentCommand: "/opt/kimi acp --foo" });
    expect(out.agentCommand).toBe("/opt/kimi acp --foo");
  });

  it("drops the model when it equals the default so ACP uses the agent default", () => {
    const out = buildKimiAcpConfig({ model: "kimi-code/kimi-for-coding" });
    expect("model" in out).toBe(false);
  });

  it("keeps a non-default model", () => {
    const out = buildKimiAcpConfig({ model: "kimi-code/k3" });
    expect(out.model).toBe("kimi-code/k3");
  });

  it("strips CLI-lane effort so ACP is not sent the unsupported `effort` control", () => {
    const out = buildKimiAcpConfig({ model: "kimi-code/k3", effort: "high", thinkingEffort: "high" });
    expect("effort" in out).toBe(false);
    expect("thinkingEffort" in out).toBe(false);
  });

  it("opts into the shared engine's verbose-backend handling", () => {
    const out = buildKimiAcpConfig({ command: "kimi" });
    expect(out.summaryStrategy).toBe("lastOutputSegment");
    expect(out.coalescePlaceholderToolUpdates).toBe(true);
  });
});

describe("nodeVersionMeetsKimiAcpMinimum", () => {
  it("accepts Node >= 20", () => {
    expect(nodeVersionMeetsKimiAcpMinimum("v22.0.0")).toBe(true);
    expect(nodeVersionMeetsKimiAcpMinimum("v20.0.0")).toBe(true);
  });
  it("rejects Node < 20", () => {
    expect(nodeVersionMeetsKimiAcpMinimum("v18.19.0")).toBe(false);
  });
});
