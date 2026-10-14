import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OpenCodeServerDriver } from "./opencode-server-driver.js";
import { parseOpenCodeReasoningMode } from "./reasoning-mode.js";
import { openCodeProxyTaskEnvelope } from "../../cli/opencode-proxy-task-envelope.js";

describe("per-turn OpenCode reasoning", () => {
  it.each([undefined, "default"])("preserves provider defaults for %s", (value) => {
    expect(parseOpenCodeReasoningMode(value)).toBe("default");
  });
  it.each(["", "false", null, false, 0])("rejects malformed mode %s", (value) => {
    expect(() => parseOpenCodeReasoningMode(value)).toThrow("turn.reasoningMode");
  });
  it("selects reasoning independently on successive turns and sends instructions once", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-turn-reasoning-"));
    const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
    await chmod(fixture, 0o755);
    const submitted: Array<{ variant?: string; system?: string; parts: Array<{ text: string }> }> = [];
    const instructions = "Unique shared agent instructions. Keep the requested scope.";
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      systemInstructions: instructions,
      taskEnvelope: openCodeProxyTaskEnvelope({ baseInstructions: instructions,
        completionContract: { revision: "17", criterionIds: ["objective"] } }),
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async")) submitted.push(JSON.parse(String(init?.body)));
        return fetch(input, init);
      },
    });
    let session: Awaited<ReturnType<OpenCodeServerDriver["openSession"]>> | undefined;
    try {
      session = await driver.openSession({ runId: "turn-reasoning", normalizedSessionId: "reasoning", workingDirectory: root });
      await expect(session.startTurn({ message: { role: "user", text: "invalid" }, reasoningMode: "bad" as never })).rejects.toThrow("turn.reasoningMode");
      expect(submitted).toHaveLength(0);
      for (const reasoningMode of [undefined, "disabled", undefined] as const) {
        await session.startTurn({ message: { role: "user", text: "Reply Hi." }, reasoningMode });
        for await (const event of session.events()) if (event.eventType === "turn.completed") break;
      }
      expect(submitted.map(body => body.variant)).toEqual(["paperclip-default", "paperclip-no-reasoning", "paperclip-default"]);
      expect(submitted[0]!.system).toBe(instructions);
      for (const body of submitted) {
        expect(body.system).toBe(instructions);
        expect(JSON.stringify(body).split(instructions)).toHaveLength(2);
      }
      const envelope = JSON.parse(submitted[0]!.parts[0].text);
      expect(envelope.task.completionContract.revision).toBe("17");
      expect(envelope.task.constraints).toEqual(["Use Paperclip MCP tools for semantic operations."]);
      const config = JSON.parse(await readFile(join(root, "reasoning/config/opencode/opencode.json"), "utf8"));
      expect(config.provider.openrouter.models["deepseek/deepseek-v4-flash-0731"]).toMatchObject({
        variants: { "paperclip-default": {}, "paperclip-no-reasoning": { reasoning: { enabled: false } } },
      });
      expect(config.provider.openrouter.models["deepseek/deepseek-v4-flash-0731"].options).toBeUndefined();
    } finally {
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
