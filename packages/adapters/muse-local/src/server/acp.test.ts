import { describe, expect, it } from "vitest";
import {
  buildMuseAcpConfig,
  nodeVersionMeetsMuseAcpMinimum,
  resolveMuseExecutionEngine,
} from "./acp.js";
import { DEFAULT_MUSE_LOCAL_MODEL } from "../index.js";
import { uuidv7, parseArgs, resolveMuseExecutable } from "../cli/muse-acp.js";

describe("resolveMuseExecutionEngine", () => {
  it("defaults to ACP (non-explicit) when engine is unset", () => {
    expect(resolveMuseExecutionEngine({})).toEqual({ engine: "acp", explicit: false });
  });

  it("honors an explicit engine=acp", () => {
    expect(resolveMuseExecutionEngine({ engine: "acp" })).toEqual({ engine: "acp", explicit: true });
  });

  it("honors an explicit engine=cli", () => {
    expect(resolveMuseExecutionEngine({ engine: "CLI" })).toEqual({ engine: "cli", explicit: true });
  });

  it("treats unknown values as the non-explicit ACP default", () => {
    expect(resolveMuseExecutionEngine({ engine: "nonsense" })).toEqual({ engine: "acp", explicit: false });
  });
});

describe("buildMuseAcpConfig", () => {
  it("targets the muse agent with persistent mode and default keepalive", () => {
    const out = buildMuseAcpConfig({ cwd: "/work" });
    expect(out.agent).toBe("muse");
    expect(out.mode).toBe("persistent");
    expect(out.cwd).toBe("/work");
    expect(out.warmHandleIdleMs).toBe(0);
  });

  it("preserves configured warmHandleIdleMs", () => {
    const out = buildMuseAcpConfig({ cwd: "/work", warmHandleIdleMs: 900_000 });
    expect(out.warmHandleIdleMs).toBe(900_000);
  });

  it("prefers an explicit agentCommand override", () => {
    const out = buildMuseAcpConfig({ agentCommand: "/custom/muse-acp --foo" });
    expect(out.agentCommand).toBe("/custom/muse-acp --foo");
  });

  it("drops the model when it equals the default so ACP uses the agent default", () => {
    const out = buildMuseAcpConfig({ model: DEFAULT_MUSE_LOCAL_MODEL });
    expect("model" in out).toBe(false);
  });

  it("keeps a non-default model", () => {
    const out = buildMuseAcpConfig({ model: "muse-spark-1.3" });
    expect(out.model).toBe("muse-spark-1.3");
  });

  it("opts into the shared engine summary and coalescing handling", () => {
    const out = buildMuseAcpConfig({});
    expect(out.summaryStrategy).toBe("lastOutputSegment");
    expect(out.coalescePlaceholderToolUpdates).toBe(true);
  });
});

describe("nodeVersionMeetsMuseAcpMinimum", () => {
  it("accepts Node >= 20", () => {
    expect(nodeVersionMeetsMuseAcpMinimum("v24.11.0")).toBe(true);
    expect(nodeVersionMeetsMuseAcpMinimum("v22.0.0")).toBe(true);
    expect(nodeVersionMeetsMuseAcpMinimum("v20.0.0")).toBe(true);
  });
  it("rejects Node < 20", () => {
    expect(nodeVersionMeetsMuseAcpMinimum("v18.19.0")).toBe(false);
  });
});

describe("uuidv7", () => {
  it("generates a valid UUIDv7 format", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("generates strictly monotonic/increasing UUIDv7 over time", async () => {
    const id1 = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const id2 = uuidv7();
    expect(id1 < id2).toBe(true);
  });
});

describe("parseArgs", () => {
  it("parses CLI flags and defaults", () => {
    const res = parseArgs(["node", "muse-acp", "--model", "muse-spark-1.3", "--provider", "meta"]);
    expect(res.options.model).toBe("muse-spark-1.3");
    expect(res.options.provider).toBe("meta");
    expect(res.options.disableSandbox).toBe(true);
    expect(res.options.trustWorkspace).toBe(true);
    expect(res.showVersion).toBe(false);
  });

  it("detects --version flag", () => {
    const res = parseArgs(["node", "muse-acp", "--version"]);
    expect(res.showVersion).toBe(true);
  });
});
