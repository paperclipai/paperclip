import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OpenCodeServerDriver,
} from "./opencode-server-driver.js";

const fixture = resolve("test/fixtures/fake-opencode-server.mjs");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("prepared OpenCode context transport", () => {
  it("sends prepared initial prompts without the proxy task envelope", async () => {
    await chmod(fixture, 0o755);
    const root = await mkdtemp(join(tmpdir(), "paperclip-opencode-prepared-"));
    const workspace = await mkdtemp(
      join(tmpdir(), "paperclip-opencode-prepared-workspace-"),
    );
    roots.push(root, workspace);
    const submitted: Record<string, unknown>[] = [];
    const driver = new OpenCodeServerDriver({
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      runtimeDirectory: root,
      command: fixture,
      conversationMode: "prepared",
      environment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      fetch: async (input, init) => {
        if (String(input).endsWith("/prompt_async"))
          submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return fetch(input, init);
      },
    });

    const session = await driver.openSession({
      runId: "run-prepared-opencode",
      normalizedSessionId: "prepared-opencode",
      workingDirectory: workspace,
    });
    await session.startTurn({
      message: { role: "user", text: "prepared OpenCode initial wake" },
    });
    for await (const event of session.events()) {
      if (event.eventType === "turn.completed") break;
    }
    const snapshot = await session.snapshot();
    await session.close({ reason: "prepared-test" });
    const recovered = await driver.recoverSession?.(snapshot);
    expect(recovered?.recovered).toBe(true);
    await recovered!.session!.startTurn({
      message: {
        role: "user",
        text: "completion-only OpenCode continuation",
      },
    });
    for await (const event of recovered!.session!.events()) {
      if (event.eventType === "turn.completed") break;
    }
    expect(submitted.map((body) => body.parts)).toEqual([
      [{ type: "text", text: "prepared OpenCode initial wake" }],
      [{ type: "text", text: "completion-only OpenCode continuation" }],
    ]);
    expect(JSON.stringify(submitted)).not.toContain('"task"');
    await recovered!.session!.close({ reason: "prepared-test-recovery" });
  });
});
