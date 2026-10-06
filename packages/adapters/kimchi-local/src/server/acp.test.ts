import { describe, expect, it } from "vitest";
import {
  buildKimchiAcpConfig,
  nodeVersionMeetsKimchiAcpMinimum,
  resolveKimchiExecutionEngine,
} from "./acp.js";

describe("resolveKimchiExecutionEngine", () => {
  it("defaults to ACP (non-explicit) when engine is unset", () => {
    expect(resolveKimchiExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
  });

  it("honors an explicit engine=acp", () => {
    expect(resolveKimchiExecutionEngine({ engine: "acp" })).toEqual({ engine: "acp", explicit: true });
  });

  it("treats a leftover engine=cli as the non-explicit ACP default (no CLI lane in v1)", () => {
    expect(resolveKimchiExecutionEngine({ engine: "cli" })).toEqual({ engine: "acp", explicit: false });
  });

  it("treats unknown values as the non-explicit ACP default", () => {
    expect(resolveKimchiExecutionEngine({ engine: "nonsense" })).toEqual({ engine: "acp", explicit: false });
  });
});

describe("buildKimchiAcpConfig", () => {
  it("targets the kimchi agent and derives the `kimchi --mode acp` server command from `command`", () => {
    const out = buildKimchiAcpConfig({ command: "kimchi", cwd: "/work" });
    expect(out.agent).toBe("kimchi");
    expect(out.agentCommand).toBe("kimchi --mode acp");
    expect(out.mode).toBe("persistent");
    expect(out.cwd).toBe("/work");
  });

  it("prefers an explicit agentCommand override", () => {
    const out = buildKimchiAcpConfig({ command: "kimchi", agentCommand: "/opt/kimchi --mode acp --foo" });
    expect(out.agentCommand).toBe("/opt/kimchi --mode acp --foo");
  });

  it("drops the model when it equals the default so ACP uses the agent default", () => {
    const out = buildKimchiAcpConfig({ model: "kimi-k2.7" });
    expect("model" in out).toBe(false);
  });

  it("keeps a non-default model", () => {
    const out = buildKimchiAcpConfig({ model: "glm-5.3" });
    expect(out.model).toBe("glm-5.3");
  });

  it("keeps permission and warm-handle settings", () => {
    const out = buildKimchiAcpConfig({
      command: "kimchi",
      permissionMode: "approve-reads",
      warmHandleIdleMs: 1234,
    });
    expect(out.permissionMode).toBe("approve-reads");
    expect(out.warmHandleIdleMs).toBe(1234);
  });
});

describe("nodeVersionMeetsKimchiAcpMinimum", () => {
  it("accepts the current node and rejects an ancient node", () => {
    expect(nodeVersionMeetsKimchiAcpMinimum(process.version)).toBe(true);
    expect(nodeVersionMeetsKimchiAcpMinimum("v18.0.0")).toBe(false);
  });
});
