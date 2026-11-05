import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { redirectClaudeAutoMemory } from "../services/managed-claude-memory.js";

const makeHome = () => fs.mkdtemp(path.join(os.tmpdir(), "managed-claude-memory-"));
const settingsPath = (home: string) => path.join(home, "provider", "settings.json");

describe("redirectClaudeAutoMemory", () => {
  it("creates settings pointing auto-memory at the agent directory", async () => {
    const home = await makeHome();
    await redirectClaudeAutoMemory(home, "/agent-home");
    expect(JSON.parse(await fs.readFile(settingsPath(home), "utf8"))).toEqual({ autoMemoryDirectory: "/agent-home/claude-memory" });
  });

  it("keeps existing settings", async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, "provider"));
    await fs.writeFile(settingsPath(home), JSON.stringify({ model: "x" }));
    await redirectClaudeAutoMemory(home, "/agent-home");
    expect(JSON.parse(await fs.readFile(settingsPath(home), "utf8"))).toEqual({ model: "x", autoMemoryDirectory: "/agent-home/claude-memory" });
  });

  it("leaves unreadable settings untouched", async () => {
    const home = await makeHome();
    await fs.mkdir(path.join(home, "provider"));
    await fs.writeFile(settingsPath(home), "not json");
    await redirectClaudeAutoMemory(home, "/agent-home");
    expect(await fs.readFile(settingsPath(home), "utf8")).toBe("not json");
  });
});
