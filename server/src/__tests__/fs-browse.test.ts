import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import os from "node:os";
import path from "node:path";
import { fsRoutes } from "../routes/fs.js";

// Mock fs.promises so tests don't depend on real filesystem
const { mockReaddir } = vi.hoisted(() => ({ mockReaddir: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  default: {
    readdir: mockReaddir,
  },
  readdir: mockReaddir,
}));

function createApp(actorType: "board" | "agent") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor =
      actorType === "board"
        ? { type: "board", userId: "user-1", source: "local_implicit" }
        : { type: "agent", agentId: "agent-1", companyId: "co-1" };
    next();
  });
  app.use("/api", fsRoutes());
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal error" });
    },
  );
  return app;
}

describe("GET /fs/browse", () => {
  beforeEach(() => {
    mockReaddir.mockReset();
  });

  it("returns 403 for agent actors", async () => {
    const app = createApp("agent");
    const res = await request(app).get("/api/fs/browse");
    expect(res.status).toBe(403);
  });

  it("returns home directory listing when no path specified", async () => {
    const home = os.homedir();
    mockReaddir.mockResolvedValueOnce([
      { name: "Documents", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "Downloads", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "file.txt", isDirectory: () => false } as unknown as import("node:fs").Dirent,
    ]);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse");

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(home);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toEqual({ name: "Documents", path: path.join(home, "Documents") });
    expect(res.body.entries[1]).toEqual({ name: "Downloads", path: path.join(home, "Downloads") });
    expect(res.body.parent).toBe(path.dirname(home));
  });

  it("returns directory listing for specified path", async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: "src", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "README.md", isDirectory: () => false } as unknown as import("node:fs").Dirent,
    ]);

    const expectedPath = path.join(path.sep, "Users", "foo", "project");
    const expectedParent = path.dirname(expectedPath);
    const expectedEntryPath = path.join(expectedPath, "src");

    const app = createApp("board");
    const res = await request(app).get(`/api/fs/browse?path=${expectedPath}`);

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(expectedPath);
    expect(res.body.parent).toBe(expectedParent);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toEqual({ name: "src", path: expectedEntryPath });
  });

  it("returns 400 for relative paths", async () => {
    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=relative/path");
    expect(res.status).toBe(400);
  });

  it("returns null parent when at filesystem root", async () => {
    mockReaddir.mockResolvedValueOnce([]);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=/");

    expect(res.status).toBe(200);
    expect(res.body.parent).toBeNull();
  });

  it("returns 404 when path does not exist", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockReaddir.mockRejectedValueOnce(err);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 400 when path is a file not a directory", async () => {
    const err = Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
    mockReaddir.mockRejectedValueOnce(err);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=/etc/hosts");
    expect(res.status).toBe(400);
  });

  it("hides dotfile directories by default", async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: ".git", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "src", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: ".hidden", isDirectory: () => true } as unknown as import("node:fs").Dirent,
    ]);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=/some/path");
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual(["src"]);
  });

  it("shows dotfile directories when showHidden=true", async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: ".git", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "src", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: ".hidden", isDirectory: () => true } as unknown as import("node:fs").Dirent,
    ]);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=/some/path&showHidden=true");
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual([".git", ".hidden", "src"]);
  });

  it("returns sorted entries", async () => {
    mockReaddir.mockResolvedValueOnce([
      { name: "zzz", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "aaa", isDirectory: () => true } as unknown as import("node:fs").Dirent,
      { name: "mmm", isDirectory: () => true } as unknown as import("node:fs").Dirent,
    ]);

    const app = createApp("board");
    const res = await request(app).get("/api/fs/browse?path=/some/path");
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { name: string }) => e.name)).toEqual(["aaa", "mmm", "zzz"]);
  });
});
