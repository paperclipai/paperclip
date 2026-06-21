import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemRoutes } from "../routes/filesystem.js";
import { errorHandler } from "../middleware/index.js";

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-filesystem-list-"));
  const homeDir = path.join(root, "home");
  const nestedDir = path.join(homeDir, "projects");
  const linkedDir = path.join(homeDir, "linked-projects");
  await fs.mkdir(nestedDir, { recursive: true });
  await fs.writeFile(path.join(homeDir, "notes.txt"), "hello", "utf8");
  await fs.symlink(nestedDir, linkedDir, "dir");
  return { root, homeDir, nestedDir, linkedDir };
}

function createApp(deploymentMode: "local_trusted" | "authenticated") {
  const app = express();
  app.use(express.json());
  app.use("/api", filesystemRoutes({ deploymentMode }));
  app.use(errorHandler);
  return app;
}

describe("GET /filesystem/list", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    fixture = await createFixture();
    process.env.HOME = fixture.homeDir;
    delete process.env.USERPROFILE;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  it("returns platform roots when path is omitted", async () => {
    const res = await request(createApp("local_trusted")).get("/api/filesystem/list");

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("");
    expect(res.body.parent).toBeNull();
    expect(res.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: fixture.homeDir, isDir: true, isSymlink: false }),
      ]),
    );
    if (process.platform === "win32") {
      expect(res.body.entries.length).toBeGreaterThan(0);
    } else {
      // "/" must not be exposed as a root; it would defeat containment.
      const rootNames = res.body.entries.map((entry: { name: string }) => entry.name);
      expect(rootNames).not.toContain("/");
    }
  });

  it("lists nested directory contents with directories first and symlink metadata", async () => {
    const res = await request(createApp("local_trusted"))
      .get("/api/filesystem/list")
      .query({ path: fixture.homeDir });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: fixture.homeDir,
      parent: path.dirname(fixture.homeDir) === fixture.homeDir ? null : path.dirname(fixture.homeDir),
      entries: [
        { name: "linked-projects", isDir: true, isSymlink: true },
        { name: "projects", isDir: true, isSymlink: false },
        { name: "notes.txt", isDir: false, isSymlink: false },
      ],
    });
  });

  it("rejects denied paths", async () => {
    if (process.platform === "win32") return;

    const target = typeof process.getuid === "function" && process.getuid() === 0
      ? "/etc/shadow"
      : "/root";
    const res = await request(createApp("local_trusted"))
      .get("/api/filesystem/list")
      .query({ path: target });

    // Denied system paths live outside the home root, so containment rejects
    // them before the explicit deny-list is even consulted.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not allowed|outside the allowed filesystem roots/);
  });

  it("rejects absolute paths outside the allowed roots", async () => {
    // fixture.root is the parent of homeDir, so it is outside the home root.
    const res = await request(createApp("local_trusted"))
      .get("/api/filesystem/list")
      .query({ path: fixture.root });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Path is outside the allowed filesystem roots" });
  });

  it("rejects a symlink whose resolved target escapes the allowed roots", async () => {
    if (process.platform === "win32") return;

    // Directory outside the home root, reached via a symlink that lives inside it.
    const outsideDir = path.join(fixture.root, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    const escapeLink = path.join(fixture.homeDir, "escape");
    await fs.symlink(outsideDir, escapeLink, "dir");

    const res = await request(createApp("local_trusted"))
      .get("/api/filesystem/list")
      .query({ path: escapeLink });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Resolved path is outside the allowed filesystem roots" });
  });

  it("rejects non-absolute paths", async () => {
    const res = await request(createApp("local_trusted"))
      .get("/api/filesystem/list")
      .query({ path: "relative/path" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Path must be absolute" });
  });

  it("returns 404 for non-existent paths", async () => {
    const missingPath = path.join(fixture.homeDir, "missing");
    const res = await request(createApp("local_trusted"))
      .get("/api/filesystem/list")
      .query({ path: missingPath });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Path not found" });
  });

  it("rejects requests outside local_trusted mode", async () => {
    const res = await request(createApp("authenticated"))
      .get("/api/filesystem/list")
      .query({ path: fixture.homeDir });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Filesystem listing is only available in local_trusted mode" });
  });
});
