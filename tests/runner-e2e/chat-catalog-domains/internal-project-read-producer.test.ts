import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OpenCodeServerDriver } from "../../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.js";
import { projectReadCalls } from "./internal-project-defaults.js";

it("accepts project reads emitted by the actual OpenCode MCP event producer", async () => {
  const root = await mkdtemp(join(tmpdir(), "catalog-project-read-producer-"));
  const command = join(root, "fake-opencode.mjs");
  await copyFile(new URL("../../../packages/paperclip-runner/test/fixtures/fake-opencode-server.mjs", import.meta.url), command);
  await chmod(command, 0o755);
  const description = "Keyboard navigation; adequate contrast; labeled controls.";
  const driver = new OpenCodeServerDriver({
    model: "openrouter/controlled-model", runtimeDirectory: join(root, "runtime"), command,
    environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "controlled-fixture-key" },
    dynamicTools: [{ name: "list_projects", inputSchema: { type: "object", properties: {} } }],
    dynamicToolHandler: async call => {
      expect(call.tool).toBe("list_projects");
      return { projects: [{ id: "project", description, descriptionTruncated: false }], nextCursor: null };
    },
  });
  const session = await driver.openSession({ runId: "owned-read-run", normalizedSessionId: "owned-read-session", workingDirectory: root });
  try {
    await session.startTurn({ message: { role: "user", text: "Read project defaults." } });
    const events = [];
    for await (const event of session.events()) {
      events.push(event);
      if (["turn.completed", "turn.failed"].includes(event.eventType)) break;
    }
    expect(events.at(-1)?.eventType).toBe("turn.completed");
    expect(events.some(event => {
      const item = event.payload.item as { type?: string; name?: string } | undefined;
      return item?.type === "tool_call" && item.name === "list_projects";
    })).toBe(true);
    expect(projectReadCalls(events, "owned-read-run", "project", description)).toHaveLength(1);
    expect(projectReadCalls(events, "foreign-run", "project", description)).toEqual([]);
    expect(projectReadCalls(events, "owned-read-run", "project", "stale defaults")).toEqual([]);
  } finally {
    await session.close({ reason: "project read producer check complete" });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
