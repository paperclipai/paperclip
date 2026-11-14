import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presentCommits } from "../services/isolated-repository-rehome.js";

const mockGetExperimental = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
  issueService: () => mockIssueService,
}));

vi.mock("../services/fast-responses.js", () => ({
  enqueueFastResponse: vi.fn(async () => undefined),
  supersedeFastResponse: vi.fn(async () => undefined),
}));

vi.mock("../routes/authz.js", () => ({
  getActorInfo: () => ({ actorId: "user-1", agentId: null, runId: null }),
  assertCompanyAccess: () => {},
}));

async function fakeBin(name: string, body: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-epipe-${name}-`));
  await fs.writeFile(path.join(dir, name), body, { mode: 0o755 });
  return dir;
}

function uncaughtCollector() {
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  process.on("uncaughtException", onError);
  return {
    errors,
    async flush() {
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    detach() {
      process.off("uncaughtException", onError);
    },
  };
}

describe("child stdin writes survive an early child exit", () => {
  const savedPath = process.env.PATH;
  let binDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    binDir = await fakeBin("git", "#!/bin/sh\nexec 0<&-\nsleep 0.3\nexit 7\n");
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("presentCommits rejects with the child exit instead of an uncaught EPIPE", async () => {
    const uncaught = uncaughtCollector();
    try {
      const commits = Array.from({ length: 4000 }, (_, index) => index.toString(16).padStart(40, "0"));
      await expect(presentCommits("/nonexistent", commits)).rejects.toMatchObject({ code: 7 });
      await uncaught.flush();
      expect(uncaught.errors).toEqual([]);
    } finally {
      uncaught.detach();
    }
  });
});

describe("POST /api/board/chat/stream when the CLI closes stdin", () => {
  const savedPath = process.env.PATH;
  let binDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    mockIssueService.list.mockResolvedValue([{ id: "issue-1", title: "Board Operations", status: "todo" }]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", createdAt: new Date().toISOString() });
    mockIssueService.listComments.mockResolvedValue([]);
    binDir = await fakeBin("claude", "#!/bin/sh\nexec 0<&-\nsleep 0.2\nexit 7\n");
    process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await fs.rm(binDir, { recursive: true, force: true });
  });

  it("completes the SSE response instead of crashing on EPIPE", async () => {
    const { boardChatRoutes } = await import("../routes/board-chat.js");
    const app = express();
    app.use(express.json({ limit: "8mb" }));
    app.use("/api", boardChatRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as never, { deploymentMode: "local_trusted" }));

    const uncaught = uncaughtCollector();
    try {
      const res = await request(app)
        .post("/api/board/chat/stream")
        .send({ companyId: "company-1", message: "x".repeat(256 * 1024) });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"done"');
      expect(res.text).toContain('"exitCode":7');
      await uncaught.flush();
      expect(uncaught.errors).toEqual([]);
    } finally {
      uncaught.detach();
    }
  }, 30_000);
});
