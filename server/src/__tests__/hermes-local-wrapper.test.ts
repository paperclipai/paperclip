import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: vi.fn(async (ctx: AdapterExecutionContext) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    resultJson: { echoedConfig: ctx.config },
  })),
}));

import { execute as upstreamHermesExecute } from "hermes-paperclip-adapter/server";
import {
  hermesExecuteWithPaperclipContext,
  withHermesRuntimeContext,
} from "../adapters/hermes-local-wrapper.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", adapterType: "hermes_local", name: "Hermes" } as any,
    runtime: {},
    config: {},
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    ...overrides,
  };
}

describe("withHermesRuntimeContext", () => {
  it("injects workspaceDir from Paperclip workspace context", () => {
    const ctx = makeCtx({
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/paperclip-workspace",
        },
      } as any,
    });

    const next = withHermesRuntimeContext(ctx);

    expect(next.config).toMatchObject({
      workspaceDir: "/tmp/paperclip-workspace",
      env: {},
    });
  });

  it("injects PAPERCLIP_API_KEY from authToken when missing", () => {
    const ctx = makeCtx({
      authToken: "jwt-token",
      config: {
        env: {
          EXISTING: "1",
        },
      },
    });

    const next = withHermesRuntimeContext(ctx);

    expect(next.config).toMatchObject({
      env: {
        EXISTING: "1",
        PAPERCLIP_API_KEY: "jwt-token",
      },
    });
    expect((next.config as any).promptTemplate).toContain("IMPORTANT: Use `terminal` tool");
    expect((next.config as any).promptTemplate).toContain("<mandatory_tool_use>");
    expect((next.config as any).promptTemplate).toContain("<act_dont_ask>");
    expect((next.config as any).promptTemplate).toContain("includeRoutineExecutions=true");
  });

  it("preserves explicit workspaceDir and existing PAPERCLIP_API_KEY", () => {
    const ctx = makeCtx({
      authToken: "jwt-token",
      config: {
        workspaceDir: "/already-set",
        env: {
          PAPERCLIP_API_KEY: "existing-key",
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/ignored",
        },
      } as any,
    });

    const next = withHermesRuntimeContext(ctx);

    expect(next.config).toMatchObject({
      workspaceDir: "/already-set",
      env: {
        PAPERCLIP_API_KEY: "existing-key",
      },
    });
  });
});

describe("hermesExecuteWithPaperclipContext", () => {
  it("forwards enriched context to upstream execute", async () => {
    const ctx = makeCtx({
      authToken: "jwt-token",
      context: {
        paperclipWorkspace: {
          cwd: "/tmp/paperclip-workspace",
        },
      } as any,
    });

    await hermesExecuteWithPaperclipContext(ctx);

    expect(upstreamHermesExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          adapterConfig: expect.objectContaining({
            promptTemplate: expect.stringContaining("<mandatory_tool_use>"),
            env: expect.objectContaining({
              PAPERCLIP_API_KEY: "jwt-token",
            }),
          }),
        }),
        config: expect.objectContaining({
          workspaceDir: "/tmp/paperclip-workspace",
          env: expect.objectContaining({
            PAPERCLIP_API_KEY: "jwt-token",
          }),
        }),
      }),
    );
  });
});
