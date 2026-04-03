import { describe, expect, it } from "vitest";
import {
  buildCursorCommandCandidates,
  classifyCursorCommand,
  resolveCursorCommand,
} from "./command.js";

describe("classifyCursorCommand", () => {
  it("treats the legacy standalone agent binary as a direct command", () => {
    expect(classifyCursorCommand("agent")).toEqual({
      invocationKind: "standalone_agent",
      baseArgs: [],
    });
  });

  it("treats the Cursor CLI as requiring the agent subcommand", () => {
    expect(classifyCursorCommand("/Applications/Cursor.app/Contents/Resources/app/bin/cursor")).toEqual({
      invocationKind: "cursor_subcommand",
      baseArgs: ["agent"],
    });
  });

  it("treats unknown wrappers as custom commands", () => {
    expect(classifyCursorCommand(process.execPath)).toEqual({
      invocationKind: "custom",
      baseArgs: [],
    });
  });
});

describe("buildCursorCommandCandidates", () => {
  it("tries the legacy agent binary first, then falls back to cursor", () => {
    expect(buildCursorCommandCandidates("")).toEqual([
      {
        command: "agent",
        invocationKind: "standalone_agent",
        baseArgs: [],
      },
      {
        command: "cursor",
        invocationKind: "cursor_subcommand",
        baseArgs: ["agent"],
      },
      {
        command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        invocationKind: "cursor_subcommand",
        baseArgs: ["agent"],
      },
      {
        command: "/Applications/Cursor EAP.app/Contents/Resources/app/bin/cursor",
        invocationKind: "cursor_subcommand",
        baseArgs: ["agent"],
      },
    ]);
  });

  it("keeps an explicit custom command as the only candidate", () => {
    expect(buildCursorCommandCandidates("/custom/bin/cursor")).toEqual([
      {
        command: "/custom/bin/cursor",
        invocationKind: "cursor_subcommand",
        baseArgs: ["agent"],
      },
    ]);
  });
});

describe("resolveCursorCommand", () => {
  it("falls back to the Cursor CLI when the legacy agent binary is unavailable", async () => {
    const seen: string[] = [];

    const resolved = await resolveCursorCommand({
      configuredCommand: "",
      cwd: "/tmp",
      env: {},
      ensureResolvable: async (command) => {
        seen.push(command);
        if (command === "agent") {
          throw new Error("agent missing");
        }
      },
    });

    expect(seen).toEqual(["agent", "cursor"]);
    expect(resolved).toEqual({
      command: "cursor",
      invocationKind: "cursor_subcommand",
      baseArgs: ["agent"],
    });
  });

  it("treats an explicit legacy 'agent' command like the old default and still falls back", async () => {
    const seen: string[] = [];

    const resolved = await resolveCursorCommand({
      configuredCommand: "agent",
      cwd: "/tmp",
      env: {},
      ensureResolvable: async (command) => {
        seen.push(command);
        if (command === "agent") {
          throw new Error("agent missing");
        }
      },
    });

    expect(seen).toEqual(["agent", "cursor"]);
    expect(resolved).toEqual({
      command: "cursor",
      invocationKind: "cursor_subcommand",
      baseArgs: ["agent"],
    });
  });
});
