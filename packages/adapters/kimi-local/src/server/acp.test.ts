import { describe, expect, it } from "vitest";
import {
  buildKimiAcpConfig,
  nodeVersionMeetsKimiAcpMinimum,
  resolveKimiExecutionEngine,
} from "./acp.js";

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
