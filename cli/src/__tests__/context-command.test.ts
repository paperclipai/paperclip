import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerContextCommands } from "../commands/client/context.js";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerContextCommands(program);
  return program;
}

function createTempContextPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-context-command-"));
  return path.join(dir, "context.json");
}

describe("context commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets a profile, marks it active, and shows it as JSON", async () => {
    const contextPath = createTempContextPath();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "context", "set",
      "--context", contextPath,
      "--profile", "agent-profile",
      "--api-base", "http://localhost:3101",
      "--company-id", "company-123",
      "--persona", "agent",
      "--agent-id", "agent-123",
      "--agent-name", "Builder",
      "--api-key-env-var-name", "PAPERCLIP_AGENT_TOKEN",
      "--use",
      "--json",
    ], { from: "user" });

    const setOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(setOutput).toMatchObject({
      currentProfile: "agent-profile",
      profileName: "agent-profile",
      profile: {
        apiBase: "http://localhost:3101",
        companyId: "company-123",
        persona: "agent",
        agentId: "agent-123",
        agentName: "Builder",
        apiKeyEnvVarName: "PAPERCLIP_AGENT_TOKEN",
      },
    });

    await createProgram().parseAsync([
      "context", "show",
      "--context", contextPath,
      "--json",
    ], { from: "user" });

    const showOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(showOutput).toMatchObject({
      currentProfile: "agent-profile",
      profileName: "agent-profile",
      profiles: {
        "agent-profile": {
          agentName: "Builder",
        },
      },
    });
  });

  it("lists profiles and switches the active profile", async () => {
    const contextPath = createTempContextPath();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync([
      "context", "set",
      "--context", contextPath,
      "--profile", "board",
      "--persona", "board",
      "--api-base", "http://localhost:3100",
      "--json",
    ], { from: "user" });
    await createProgram().parseAsync([
      "context", "set",
      "--context", contextPath,
      "--profile", "agent",
      "--persona", "agent",
      "--agent-id", "agent-123",
      "--json",
    ], { from: "user" });
    await createProgram().parseAsync([
      "context", "use", "agent",
      "--context", contextPath,
    ], { from: "user" });
    await createProgram().parseAsync([
      "context", "list",
      "--context", contextPath,
      "--json",
    ], { from: "user" });

    const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(rows).toEqual([
      expect.objectContaining({ name: "default", current: false }),
      expect.objectContaining({ name: "board", current: false, persona: "board" }),
      expect.objectContaining({ name: "agent", current: true, persona: "agent", agentId: "agent-123" }),
    ]);
  });

  it("rejects invalid persona values", async () => {
    await expect(createProgram().parseAsync([
      "context", "set",
      "--context", createTempContextPath(),
      "--persona", "operator",
    ], { from: "user" })).rejects.toThrow("Invalid --persona value. Use board or agent.");
  });
});
