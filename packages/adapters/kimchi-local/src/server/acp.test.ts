import { describe, expect, it, vi } from "vitest";
import {
  buildKimchiAcpConfig,
  commandIsResolvable,
  nodeVersionMeetsKimchiAcpMinimum,
  resolveKimchiExecutionEngine,
} from "./acp.js";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const original = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...original,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCwd: vi.fn((_target: unknown, configured: string, fallback: string) =>
      configured.trim().length > 0 ? configured : fallback,
    ),
    readAdapterExecutionTarget: vi.fn((input: { executionTarget?: unknown }) => input.executionTarget),
  };
});

const { ensureAdapterExecutionTargetCommandResolvable } = await import(
  "@paperclipai/adapter-utils/execution-target"
);

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

  it("appends extraArgs to the spawned ACP server command (P1 regression guard)", () => {
    const out = buildKimchiAcpConfig({
      command: "kimchi",
      extraArgs: ["--strict", "--verbose"],
    });
    expect(out.agentCommand).toBe("kimchi --mode acp '--strict' '--verbose'");
  });

  it("appends extraArgs when agentCommand is overridden", () => {
    const out = buildKimchiAcpConfig({
      agentCommand: "/opt/kimchi --mode acp",
      extraArgs: ["--foo"],
    });
    expect(out.agentCommand).toBe("/opt/kimchi --mode acp '--foo'");
  });

  it("leaves agentCommand untouched when extraArgs is empty", () => {
    const out = buildKimchiAcpConfig({
      command: "kimchi",
      extraArgs: [],
    });
    expect(out.agentCommand).toBe("kimchi --mode acp");
  });

  it("shell-quotes extraArgs so embedded whitespace does not split tokens", () => {
    const out = buildKimchiAcpConfig({
      command: "kimchi",
      extraArgs: ["--prompt", "hello world"],
    });
    expect(out.agentCommand).toBe(`kimchi --mode acp '--prompt' 'hello world'`);
  });
});

describe("commandIsResolvable remote PATH resolution", () => {
  it("uses the target's configured env.PATH instead of the server PATH when set", async () => {
    (ensureAdapterExecutionTargetCommandResolvable as ReturnType<typeof vi.fn>).mockClear();
    const hostHome = process.env.HOME;
    delete process.env.HOME;
    try {
      const result = await commandIsResolvable(
        "/opt/kimchi/bin/kimchi",
        "/should/be/ignored",
        {
          config: {
            env: { PATH: "/opt/kimchi/bin:/usr/local/bin" },
            cwd: "/work",
          },
          executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" } as any,
          executionTransport: {},
        },
      );
      expect(result).toBe(true);
      expect(ensureAdapterExecutionTargetCommandResolvable).toHaveBeenCalledWith(
        "/opt/kimchi/bin/kimchi",
        { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
        "/work",
        { PATH: "/opt/kimchi/bin:/usr/local/bin" },
      );
    } finally {
      if (hostHome !== undefined) process.env.HOME = hostHome;
    }
  });

  it("falls back to the server PATH when the target config has no env.PATH", async () => {
    (ensureAdapterExecutionTargetCommandResolvable as ReturnType<typeof vi.fn>).mockClear();
    const hostPath = process.env.PATH;
    const hostHome = process.env.HOME;
    process.env.PATH = "/host/bin";
    process.env.HOME = "/host/home";
    try {
      await commandIsResolvable(
        "/opt/kimchi/bin/kimchi",
        "/should/be/ignored",
        {
          config: { cwd: "/work" },
          executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/work" } as any,
          executionTransport: {},
        },
      );
      expect(ensureAdapterExecutionTargetCommandResolvable).toHaveBeenCalledWith(
        "/opt/kimchi/bin/kimchi",
        { kind: "remote", transport: "sandbox", remoteCwd: "/work" },
        "/work",
        { PATH: "/host/bin", HOME: "/host/home" },
      );
    } finally {
      if (hostPath === undefined) delete process.env.PATH;
      else process.env.PATH = hostPath;
      if (hostHome === undefined) delete process.env.HOME;
      else process.env.HOME = hostHome;
    }
  });
});

describe("nodeVersionMeetsKimchiAcpMinimum", () => {
  it("accepts the current node and rejects an ancient node", () => {
    expect(nodeVersionMeetsKimchiAcpMinimum(process.version)).toBe(true);
    expect(nodeVersionMeetsKimchiAcpMinimum("v18.0.0")).toBe(false);
  });
});
