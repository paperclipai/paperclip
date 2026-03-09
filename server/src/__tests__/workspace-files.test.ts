import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Db } from "@paperclipai/db";
import { workspaceFilesRoutes } from "../routes/workspace-files.js";
import { errorHandler } from "../middleware/error-handler.js";

// Mock the services so we don't need a real database
vi.mock("../services/index.js", () => ({
  projectService: vi.fn(),
}));

const { projectService } = await import("../services/index.js");

const COMPANY_ID = "company-1";
const PROJECT_ID = "project-1";
const WORKSPACE_ID = "workspace-1";

let tmpDir: string;

function makeApp(workspacePath: string) {
  const mockProjectSvc = {
    getWorkspaceByIdOnly: vi.fn().mockResolvedValue({
      id: WORKSPACE_ID,
      companyId: COMPANY_ID,
      projectId: PROJECT_ID,
      name: "Test Workspace",
      cwd: workspacePath,
      repoUrl: null,
      repoRef: null,
      metadata: null,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    getById: vi.fn().mockResolvedValue({
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      name: "Test Project",
    }),
  };

  vi.mocked(projectService).mockReturnValue(mockProjectSvc as any);

  const app = express();
  app.use(express.json());

  // Inject an authorized agent actor for all requests
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", companyId: COMPANY_ID, agentId: "agent-1" };
    next();
  });

  app.use("/api", workspaceFilesRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

function makeAppWithMissingWorkspace() {
  vi.mocked(projectService).mockReturnValue({
    getWorkspaceByIdOnly: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(null),
  } as any);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", companyId: COMPANY_ID, agentId: "agent-1" };
    next();
  });
  app.use("/api", workspaceFilesRoutes({} as Db));
  app.use(errorHandler);
  return app;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-files-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/files — List directory
// ---------------------------------------------------------------------------
describe("GET /api/workspaces/:workspaceId/files", () => {
  it("returns items in the workspace root by default", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "hi");
    await fs.mkdir(path.join(tmpDir, "subdir"));

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(".");
    const names = res.body.items.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(["hello.txt", "subdir"]);
  });

  it("returns items in a subdirectory when path query is given", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export {}");

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files?path=src`);

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("src");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("index.ts");
    expect(res.body.items[0].type).toBe("file");
    expect(typeof res.body.items[0].size).toBe("number");
    expect(typeof res.body.items[0].modified).toBe("string");
  });

  it("returns directories with null size", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "myfolder"));

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);

    expect(res.status).toBe(200);
    const dir = res.body.items.find((i: { name: string }) => i.name === "myfolder");
    expect(dir).toBeDefined();
    expect(dir.type).toBe("directory");
    expect(dir.size).toBeNull();
  });

  it("returns 404 when workspace not found", async () => {
    const app = makeAppWithMissingWorkspace();
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 404 when path does not exist", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files?path=nonexistent`);
    expect(res.status).toBe(404);
  });

  it("returns 400 when path is not a directory", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "file.txt"), "content");

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files?path=file.txt`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a directory/i);
  });

  it("returns 400 on directory traversal attempt", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files?path=../`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 on deep directory traversal with intermediate dirs", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files?path=subdir/../../..`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when an absolute path is injected that escapes the workspace", async () => {
    const app = makeApp(tmpDir);
    // path.resolve(root, "/etc") === "/etc", which is outside the workspace root
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files?path=/etc`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns the relative path in the response body", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "lib"));
    await fs.writeFile(path.join(tmpDir, "lib", "utils.ts"), "");

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files?path=lib`);

    expect(res.status).toBe(200);
    // The echoed path in the response must match what was sent
    expect(res.body.path).toBe("lib");
  });

  it("returns an empty items array for an empty directory", async () => {
    const app = makeApp(tmpDir);
    // tmpDir is empty at test start
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("includes both files and directories in the listing", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "readme.md"), "# readme");
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.mkdir(path.join(tmpDir, "dist"));

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(200);

    const fileItem = res.body.items.find((i: { name: string }) => i.name === "readme.md");
    const srcItem = res.body.items.find((i: { name: string }) => i.name === "src");
    const distItem = res.body.items.find((i: { name: string }) => i.name === "dist");

    expect(fileItem.type).toBe("file");
    expect(fileItem.size).toBeGreaterThan(0);
    expect(srcItem.type).toBe("directory");
    expect(srcItem.size).toBeNull();
    expect(distItem.type).toBe("directory");
  });

  it("returns 404 when workspace has no local directory (repo-only)", async () => {
    vi.mocked(projectService).mockReturnValue({
      getWorkspaceByIdOnly: vi.fn().mockResolvedValue({
        id: WORKSPACE_ID,
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        name: "Repo Only",
        cwd: null,
        repoUrl: "https://github.com/org/repo",
        repoRef: null,
        metadata: null,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getById: vi.fn().mockResolvedValue({
        id: PROJECT_ID,
        companyId: COMPANY_ID,
        name: "Test Project",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", companyId: COMPANY_ID, agentId: "agent-1" };
      next();
    });
    app.use("/api", workspaceFilesRoutes({} as Db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/workspaces/:workspaceId/files/read — Read file
// ---------------------------------------------------------------------------
describe("GET /api/workspaces/:workspaceId/files/read", () => {
  it("returns file content", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "hello.txt"), "Hello, world!");

    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=hello.txt`,
    );

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("hello.txt");
    expect(res.body.content).toBe("Hello, world!");
  });

  it("returns file content for nested path", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "index.ts"), "export const x = 1;");

    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=src/index.ts`,
    );

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("export const x = 1;");
  });

  it("returns empty string for empty file", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "empty.txt"), "");

    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=empty.txt`,
    );

    expect(res.status).toBe(200);
    expect(res.body.content).toBe("");
  });

  it("returns 400 when path query param is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files/read`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path query parameter is required/i);
  });

  it("returns 404 when workspace not found", async () => {
    const app = makeAppWithMissingWorkspace();
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=file.txt`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when file does not exist", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=missing.txt`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when path points to a directory", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "adir"));

    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=adir`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a file/i);
  });

  it("returns 400 on directory traversal attempt", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=../../etc/passwd`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when path resolves to the workspace root itself", async () => {
    const app = makeApp(tmpDir);
    // "." resolves to the workspace root — reading it as a file must be rejected
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=.`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when an absolute path is injected that escapes the workspace", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/files/read?path=/etc/hosts`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/files/write — Write file
// ---------------------------------------------------------------------------
describe("POST /api/workspaces/:workspaceId/files/write", () => {
  it("creates a new file and returns metadata", async () => {
    const app = makeApp(tmpDir);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "new-file.txt", content: "Hello!" });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("new-file.txt");
    expect(typeof res.body.size).toBe("number");
    expect(typeof res.body.modified).toBe("string");

    const written = await fs.readFile(path.join(tmpDir, "new-file.txt"), "utf-8");
    expect(written).toBe("Hello!");
  });

  it("overwrites an existing file", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "existing.txt"), "old content");

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "existing.txt", content: "new content" });

    expect(res.status).toBe(200);
    const written = await fs.readFile(path.join(tmpDir, "existing.txt"), "utf-8");
    expect(written).toBe("new content");
  });

  it("creates parent directories automatically", async () => {
    const app = makeApp(tmpDir);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "deep/nested/file.ts", content: "export {}" });

    expect(res.status).toBe(200);
    const stat = await fs.stat(path.join(tmpDir, "deep", "nested", "file.ts"));
    expect(stat.isFile()).toBe(true);
  });

  it("accepts empty string content", async () => {
    const app = makeApp(tmpDir);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "empty.txt", content: "" });

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(0);
  });

  it("returns 400 when path is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ content: "Hello" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path is required/i);
  });

  it("returns 400 when content is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "file.txt" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it("returns 400 when content is a number (not a string)", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "file.txt", content: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content must be a string/i);
  });

  it("returns 400 when content is an object (not a string)", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "file.txt", content: { nested: "value" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content must be a string/i);
  });

  it("returns 400 when content is an array (not a string)", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "file.txt", content: ["a", "b"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content must be a string/i);
  });

  it("returns 400 on directory traversal attempt", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "../escape.txt", content: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when path resolves to the workspace root itself", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: ".", content: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when an absolute path escapes the workspace", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "/tmp/malicious.txt", content: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when content is null explicitly", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "file.txt", content: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it("returns 404 when workspace not found", async () => {
    const app = makeAppWithMissingWorkspace();
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/write`)
      .send({ path: "file.txt", content: "x" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/files/mkdir — Create directory
// ---------------------------------------------------------------------------
describe("POST /api/workspaces/:workspaceId/files/mkdir", () => {
  it("creates a directory and returns the path", async () => {
    const app = makeApp(tmpDir);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({ path: "newdir" });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("newdir");

    const stat = await fs.stat(path.join(tmpDir, "newdir"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("creates intermediate directories (mkdir -p behaviour)", async () => {
    const app = makeApp(tmpDir);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({ path: "a/b/c" });

    expect(res.status).toBe(200);
    const stat = await fs.stat(path.join(tmpDir, "a", "b", "c"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("succeeds silently if directory already exists", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "existing"));

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({ path: "existing" });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe("existing");
  });

  it("returns 400 when path is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path is required/i);
  });

  it("returns 400 on directory traversal attempt", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({ path: "../../escape" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when path resolves to the workspace root itself", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({ path: "." });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 404 when workspace not found", async () => {
    const app = makeAppWithMissingWorkspace();
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/mkdir`)
      .send({ path: "newdir" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/:workspaceId/files — Delete file or directory
// ---------------------------------------------------------------------------
describe("DELETE /api/workspaces/:workspaceId/files", () => {
  it("deletes a file", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "todelete.txt"), "bye");

    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/files?path=todelete.txt`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: "todelete.txt", deleted: true });

    await expect(fs.stat(path.join(tmpDir, "todelete.txt"))).rejects.toThrow();
  });

  it("recursively deletes a directory", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "subdir"));
    await fs.writeFile(path.join(tmpDir, "subdir", "file.txt"), "content");

    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/files?path=subdir`,
    );

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    await expect(fs.stat(path.join(tmpDir, "subdir"))).rejects.toThrow();
  });

  it("returns 400 when path query param is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/path query parameter is required/i);
  });

  it("returns 404 when path does not exist", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/files?path=ghost.txt`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 on directory traversal attempt", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/files?path=../`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 404 when workspace not found", async () => {
    const app = makeAppWithMissingWorkspace();
    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/files?path=file.txt`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when path resolves to the workspace root itself", async () => {
    const app = makeApp(tmpDir);
    // "." resolves to the workspace root — deleting it must be rejected
    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/files?path=.`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });
});

// ---------------------------------------------------------------------------
// POST /api/workspaces/:workspaceId/files/rename — Rename or move
// ---------------------------------------------------------------------------
describe("POST /api/workspaces/:workspaceId/files/rename", () => {
  it("renames a file", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "old.txt"), "content");

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "old.txt", newPath: "new.txt" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ oldPath: "old.txt", newPath: "new.txt" });

    await expect(fs.stat(path.join(tmpDir, "old.txt"))).rejects.toThrow();
    const stat = await fs.stat(path.join(tmpDir, "new.txt"));
    expect(stat.isFile()).toBe(true);
  });

  it("moves a file to a subdirectory, creating intermediate dirs", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "file.ts"), "data");

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "file.ts", newPath: "src/utils/file.ts" });

    expect(res.status).toBe(200);
    const stat = await fs.stat(path.join(tmpDir, "src", "utils", "file.ts"));
    expect(stat.isFile()).toBe(true);
  });

  it("renames a directory", async () => {
    const app = makeApp(tmpDir);
    await fs.mkdir(path.join(tmpDir, "olddir"));
    await fs.writeFile(path.join(tmpDir, "olddir", "file.txt"), "x");

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "olddir", newPath: "newdir" });

    expect(res.status).toBe(200);
    const stat = await fs.stat(path.join(tmpDir, "newdir", "file.txt"));
    expect(stat.isFile()).toBe(true);
    await expect(fs.stat(path.join(tmpDir, "olddir"))).rejects.toThrow();
  });

  it("returns 400 when oldPath is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ newPath: "new.txt" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/oldPath is required/i);
  });

  it("returns 400 when newPath is missing", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "old.txt" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/newPath is required/i);
  });

  it("returns 404 when source path does not exist", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "ghost.txt", newPath: "new.txt" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source path not found/i);
  });

  it("returns 400 when oldPath escapes workspace root", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "../outside.txt", newPath: "inside.txt" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when newPath escapes workspace root", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "file.txt"), "x");
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "file.txt", newPath: "../../outside.txt" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 404 when workspace not found", async () => {
    const app = makeAppWithMissingWorkspace();
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "a.txt", newPath: "b.txt" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when both oldPath and newPath escape workspace root", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "../../a.txt", newPath: "../../b.txt" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("overwrites an existing file at newPath", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "source.txt"), "source content");
    await fs.writeFile(path.join(tmpDir, "dest.txt"), "old dest content");

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "source.txt", newPath: "dest.txt" });

    expect(res.status).toBe(200);
    // source is gone
    await expect(fs.stat(path.join(tmpDir, "source.txt"))).rejects.toThrow();
    // dest now has source content
    const content = await fs.readFile(path.join(tmpDir, "dest.txt"), "utf-8");
    expect(content).toBe("source content");
  });

  it("returns 400 when newPath resolves to the workspace root itself", async () => {
    const app = makeApp(tmpDir);
    await fs.writeFile(path.join(tmpDir, "file.txt"), "x");

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: "file.txt", newPath: "." });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });

  it("returns 400 when oldPath resolves to the workspace root itself", async () => {
    const app = makeApp(tmpDir);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/files/rename`)
      .send({ oldPath: ".", newPath: "newname" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid path/i);
  });
});

// ---------------------------------------------------------------------------
// Authorization edge cases
// ---------------------------------------------------------------------------
describe("Authorization", () => {
  it("returns 403 when actor belongs to a different company", async () => {
    vi.mocked(projectService).mockReturnValue({
      getWorkspaceByIdOnly: vi.fn().mockResolvedValue({
        id: WORKSPACE_ID,
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        name: "Test Workspace",
        cwd: tmpDir,
        repoUrl: null,
        repoRef: null,
        metadata: null,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getById: vi.fn().mockResolvedValue({
        id: PROJECT_ID,
        companyId: "other-company",
        name: "Other Company Project",
      }),
    } as any);

    const app = express();
    app.use(express.json());
    // Actor belongs to COMPANY_ID, but project belongs to "other-company"
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", companyId: COMPANY_ID, agentId: "agent-1" };
      next();
    });
    app.use("/api", workspaceFilesRoutes({} as Db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(403);
  });

  it("returns 404 when project for workspace is not found", async () => {
    vi.mocked(projectService).mockReturnValue({
      getWorkspaceByIdOnly: vi.fn().mockResolvedValue({
        id: WORKSPACE_ID,
        companyId: COMPANY_ID,
        projectId: "nonexistent-project",
        name: "Test Workspace",
        cwd: tmpDir,
        repoUrl: null,
        repoRef: null,
        metadata: null,
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      getById: vi.fn().mockResolvedValue(null),
    } as any);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", companyId: COMPANY_ID, agentId: "agent-1" };
      next();
    });
    app.use("/api", workspaceFilesRoutes({} as Db));
    app.use(errorHandler);

    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/files`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
