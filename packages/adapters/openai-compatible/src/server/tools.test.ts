import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPaperclipRequestUrl, buildToolDefinitions, executeTool, resolveInside } from "./tools.js";
import { parseSkillDescription } from "./skills.js";

describe("buildPaperclipRequestUrl", () => {
  const base = "http://localhost:3100";

  it("allows same-origin /api paths and merges query params", () => {
    expect(buildPaperclipRequestUrl(base, "/api/issues?limit=5", { status: "todo" })?.toString()).toBe(
      "http://localhost:3100/api/issues?limit=5&status=todo",
    );
  });

  it("refuses absolute, protocol-relative, and non-api paths", () => {
    expect(buildPaperclipRequestUrl(base, "https://evil.example/api/x", null)).toBeNull();
    expect(buildPaperclipRequestUrl(base, "//evil.example/api/x", null)).toBeNull();
    expect(buildPaperclipRequestUrl(base, "/health", null)).toBeNull();
    expect(buildPaperclipRequestUrl(base, "/api/../health", null)).toBeNull();
  });
});

describe("resolveInside", () => {
  it("keeps paths inside the root", () => {
    expect(resolveInside("/work", "src/a.ts")).toBe(path.resolve("/work/src/a.ts"));
    expect(resolveInside("/work", "../etc/passwd")).toBeNull();
    expect(resolveInside("/work", "/etc/passwd")).toBeNull();
  });
});

describe("buildToolDefinitions", () => {
  it("only exposes workspace tools when enabled", () => {
    const names = (opts: { workspaceTools: boolean; hasSkills: boolean }) =>
      buildToolDefinitions(opts).map((tool) => tool.function.name);
    expect(names({ workspaceTools: false, hasSkills: false })).toEqual(["paperclip_api_request"]);
    expect(names({ workspaceTools: true, hasSkills: true })).toEqual([
      "paperclip_api_request",
      "load_skill",
      "run_shell",
      "read_file",
      "write_file",
    ]);
  });
});

describe("executeTool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends Paperclip requests with the run token and run id", async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 201 }));
    const result = await executeTool(
      "paperclip_api_request",
      JSON.stringify({ method: "post", path: "/api/issues/i-1/comments", body: { body: "hi" } }),
      { paperclipApiUrl: "http://localhost:3100", authToken: "run-jwt", runId: "run-1", skills: [], workspace: null, fetchImpl },
    );
    expect(result).toEqual({ content: 'HTTP 201\n{"ok":true}', isError: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:3100/api/issues/i-1/comments");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer run-jwt", "x-paperclip-run-id": "run-1" });
    expect(init.body).toBe('{"body":"hi"}');
  });

  it("reports invalid arguments and disabled tools as tool errors", async () => {
    const ctx = { paperclipApiUrl: "http://localhost:3100", authToken: "t", runId: "r", skills: [], workspace: null };
    expect((await executeTool("paperclip_api_request", "not json", ctx)).isError).toBe(true);
    expect(await executeTool("run_shell", '{"command":"ls"}', ctx)).toEqual({
      content: "Error: run_shell is not enabled for this agent.",
      isError: true,
    });
  });

  it("runs workspace tools inside the workspace only", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "oa-compat-"));
    const ctx = {
      paperclipApiUrl: null,
      authToken: null,
      runId: "r",
      skills: [],
      workspace: { cwd, env: { ...process.env }, shellTimeoutMs: 10_000 },
    };
    try {
      expect((await executeTool("write_file", JSON.stringify({ path: "a/b.txt", content: "hello" }), ctx)).isError).toBe(false);
      expect(await executeTool("read_file", '{"path":"a/b.txt"}', ctx)).toEqual({ content: "hello", isError: false });
      expect((await executeTool("write_file", JSON.stringify({ path: "../escape.txt", content: "x" }), ctx)).isError).toBe(true);
      const shell = await executeTool("run_shell", '{"command":"cat a/b.txt; exit 3"}', ctx);
      expect(shell.isError).toBe(true);
      expect(shell.content).toContain("exit_code: 3");
      expect(shell.content).toContain("hello");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads skills by runtime name and refuses files outside the skill", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oa-skill-"));
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: demo\n---\nbody");
    const skills = [{ key: "paperclipai/paperclip/demo", runtimeName: "demo", source: dir, description: "" }];
    const ctx = { paperclipApiUrl: null, authToken: null, runId: "r", skills, workspace: null };
    try {
      expect((await executeTool("load_skill", '{"name":"demo"}', ctx)).content).toContain("body");
      expect((await executeTool("load_skill", '{"name":"demo","file":"../../etc/hosts"}', ctx)).isError).toBe(true);
      expect((await executeTool("load_skill", '{"name":"missing"}', ctx)).content).toContain("Available skills: demo");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseSkillDescription", () => {
  it("reads inline and folded descriptions", () => {
    expect(parseSkillDescription('---\nname: a\ndescription: "Use for X"\n---\n')).toBe("Use for X");
    expect(parseSkillDescription("---\nname: a\ndescription: >\n  Use for X\n  and Y.\nother: 1\n---\n")).toBe("Use for X and Y.");
    expect(parseSkillDescription("no frontmatter")).toBe("");
  });
});
