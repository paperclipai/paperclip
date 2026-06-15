import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRuntimeCommands } from "../commands/client/runtime.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerRuntimeCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base",
    "http://localhost:3100",
    "--api-key",
    "board-token",
  ], { from: "user" });
}

describe("runtime commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forces Codex through the instance experimental settings endpoint", async () => {
    const current = {
      masterRuntimeFailover: {
        mode: "auto",
        claudeLimitedUntil: "2099-01-01T00:00:00.000Z",
        codexLimitedUntil: null,
        activeRuntime: "codex",
        reason: "claude_hard_limit",
        updatedAt: "2026-06-15T00:00:00.000Z",
      },
    };
    const updated = {
      masterRuntimeFailover: {
        ...current.masterRuntimeFailover,
        mode: "force_codex",
        activeRuntime: "codex",
        reason: "manual_force_codex_clear_limits",
        claudeLimitedUntil: null,
        updatedAt: "2026-06-15T01:00:00.000Z",
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(current), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(updated), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["runtime", "force-codex", "--clear-limits"]);

    expect(fetchMock.mock.calls.map((call) => [call[1]?.method ?? "GET", call[0]])).toEqual([
      ["GET", "http://localhost:3100/api/instance/settings/experimental"],
      ["PATCH", "http://localhost:3100/api/instance/settings/experimental"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      masterRuntimeFailover: {
        mode: "force_codex",
        activeRuntime: "codex",
        claudeLimitedUntil: null,
        codexLimitedUntil: null,
        reason: "manual_force_codex_clear_limits",
      },
    });
  });

  it("rolls back to automatic routing", async () => {
    const current = {
      masterRuntimeFailover: {
        mode: "force_codex",
        claudeLimitedUntil: null,
        codexLimitedUntil: null,
        activeRuntime: "codex",
        reason: "manual_force_codex",
        updatedAt: "2026-06-15T00:00:00.000Z",
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(current), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        masterRuntimeFailover: {
          ...current.masterRuntimeFailover,
          mode: "auto",
          activeRuntime: null,
          reason: "manual_auto",
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["runtime", "auto"]);

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      masterRuntimeFailover: {
        mode: "auto",
        activeRuntime: null,
        reason: "manual_auto",
      },
    });
  });
});
