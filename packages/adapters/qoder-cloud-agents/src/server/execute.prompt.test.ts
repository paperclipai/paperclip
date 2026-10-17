import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import {
  DEFAULT_TURN,
  createContext,
  createFakeQoder,
  json,
  sentPrompt,
  sse,
} from "./test-support.js";

describe("qoder_cloud_agents prompt delivery", () => {
  const runtimeTools = (baseUrl: string) => ({
    version: 1 as const,
    guidance: "Use connection tools.",
    mcpEndpoint: `${baseUrl}/mcp/runtime-tools`,
    rest: {
      connectionsSearch: `${baseUrl}/runtime-tools/connections/search`,
      connectionRequest: `${baseUrl}/runtime-tools/connections/request`,
    },
    bearerToken: "runtime-tools-secret-token",
    expiresAt: "2026-01-01T01:00:00.000Z",
    tools: ["connections_search", "connection_request"] as const,
  });

  it("sends run-scoped connection tools in the prompt and keeps the token out of the run log", async () => {
    const qoder = createFakeQoder();
    const ctx = createContext({ runtimeTools: runtimeTools("https://paperclip.example.com/api") });
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    const prompt = sentPrompt(qoder);
    expect(prompt).toContain("POST https://paperclip.example.com/api/runtime-tools/connections/search");
    expect(prompt).toContain("POST https://paperclip.example.com/api/runtime-tools/connections/request");
    expect(prompt).toContain("Authorization: Bearer runtime-tools-secret-token");
    expect(String(ctx.meta[0].prompt)).toContain("Authorization: Bearer [redacted]");
    expect(JSON.stringify(ctx.meta)).not.toContain("runtime-tools-secret-token");
    expect(JSON.stringify(ctx.logs)).not.toContain("runtime-tools-secret-token");
    expect(JSON.stringify(result)).not.toContain("runtime-tools-secret-token");
    const createdSession = qoder.calls.find((call) => call.method === "POST" && call.path === "/sessions")?.body;
    expect(JSON.stringify(createdSession)).not.toContain("runtime-tools-secret-token");
  });

  it("reads connection tools from the invocation context and never echoes the prompt event to the log", async () => {
    const qoder = createFakeQoder({
      "GET /sessions/:id/events/stream": () => sse([
        { id: "evt_user", type: "user.message", content: [{ type: "text", text: "Bearer runtime-tools-secret-token" }] },
        ...DEFAULT_TURN,
      ]),
    });
    const ctx = createContext();
    ctx.context = { ...ctx.context, paperclipRuntimeTools: runtimeTools("https://paperclip.example.com/api") };
    const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
    expect(result.exitCode).toBe(0);
    expect(sentPrompt(qoder)).toContain("Authorization: Bearer runtime-tools-secret-token");
    expect(JSON.stringify(ctx.logs)).not.toContain("runtime-tools-secret-token");
  });

  it.each(["http://localhost:3100/api", "http://127.0.0.1:3100/api", "http://[::1]:3100/api"])(
    "does not expose the connection token when Paperclip is only reachable at %s",
    async (baseUrl) => {
      const qoder = createFakeQoder();
      const ctx = createContext({ runtimeTools: runtimeTools(baseUrl) });
      const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
      expect(result.exitCode).toBe(0);
      expect(sentPrompt(qoder)).not.toContain("runtime-tools-secret-token");
      expect((ctx.meta[0].commandNotes as string[]).join("\n")).toContain("loopback address Qoder cannot reach");
    },
  );

  it("inlines only the files the instructions reference, never the rest of the directory", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-instructions-"));
    const dir = path.join(parent, "bundle");
    try {
      await fs.mkdir(path.join(dir, "playbooks"), { recursive: true });
      await fs.mkdir(path.join(dir, ".hidden"));
      await fs.writeFile(
        path.join(dir, "AGENTS.md"),
        "Entry instructions. Read [the soul](./SOUL.md), `playbooks/review.md`, huge.md, ../outside.md, .hidden/secret.md and missing.md.",
      );
      await fs.writeFile(path.join(dir, "SOUL.md"), "Soul file body.");
      await fs.writeFile(path.join(dir, "playbooks", "review.md"), "Review playbook body. Then follow checklist.md.");
      await fs.writeFile(path.join(dir, "playbooks", "checklist.md"), "Checklist body.");
      await fs.writeFile(path.join(dir, "credentials.json"), '{"token":"unreferenced-credential"}');
      await fs.writeFile(path.join(dir, "notes.md"), "unreferenced notes body");
      await fs.writeFile(path.join(dir, ".hidden", "secret.md"), "hidden body");
      await fs.writeFile(path.join(dir, "huge.md"), "x".repeat(130_000));
      await fs.writeFile(path.join(parent, "outside.md"), "outside body");
      const qoder = createFakeQoder();
      const ctx = createContext();
      ctx.config.instructionsFilePath = path.join(dir, "AGENTS.md");
      const readFile = vi.spyOn(fs, "readFile");
      const result = await execute(ctx, { fetchImpl: qoder.fetchImpl });
      const readPaths = readFile.mock.calls.map((call) => path.basename(String(call[0])));
      readFile.mockRestore();
      expect(result.exitCode).toBe(0);
      const prompt = sentPrompt(qoder);
      expect(prompt).toContain("Entry instructions.");
      expect(prompt).toContain('<file path="SOUL.md">\nSoul file body.\n</file>');
      expect(prompt).toContain('<file path="playbooks/review.md">');
      expect(prompt).toContain('<file path="playbooks/checklist.md">\nChecklist body.\n</file>');
      expect(prompt).toContain("too large to include: huge.md");
      expect(prompt).not.toContain("unreferenced-credential");
      expect(prompt).not.toContain("unreferenced notes body");
      expect(prompt).not.toContain("hidden body");
      expect(prompt).not.toContain("outside body");
      expect(prompt).not.toContain(parent);
      // Oversized and unreferenced files are rejected by size or never opened at all.
      expect(readPaths.sort()).toEqual(["AGENTS.md", "SOUL.md", "checklist.md", "review.md"]);
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
