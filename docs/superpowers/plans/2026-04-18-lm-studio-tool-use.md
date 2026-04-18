# LM Studio Adapter Tool-Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing LM Studio adapter with a full agent-loop using OpenAI function calling, so local LLMs can call Paperclip APIs, read/write files, and execute shell/git commands.

**Architecture:** The adapter's `execute()` runs an internal loop (max 25 iterations): call LLM with `tools[]` parameter → parse `tool_calls` from response → execute tools locally (HTTP fetch for Paperclip API, fs/child_process for local ops) → append results as `role: "tool"` messages → repeat until LLM returns pure text. The final text answer is streamed token-by-token for UI responsiveness.

**Tech Stack:** TypeScript, native fetch (Node 18+), node:fs/promises, node:child_process, vitest

---

## File Structure

```
paperclip-adapter-lmstudio/src/
├── server/
│   ├── execute.ts              # Agent-loop (REWRITTEN)
│   ├── tools.ts                # OpenAI function definitions (NEW)
│   ├── tool-executor.ts        # Tool dispatcher (NEW)
│   ├── paperclip-tools.ts      # Paperclip API handlers (NEW)
│   ├── fs-tools.ts             # Filesystem handlers (NEW)
│   ├── shell-tools.ts          # Shell/Git handlers (NEW)
│   ├── path-safety.ts          # Path traversal guard (NEW)
│   ├── llm-client.ts           # LM Studio HTTP calls (NEW)
│   ├── models.ts               # UNCHANGED
│   ├── test.ts                 # UNCHANGED
│   └── index.ts                # MODIFIED: add maxIterations to schema
├── ui-parser.ts                # MODIFIED: parse JSON tool events
└── index.ts                    # UNCHANGED
```

---

### Task 1: Path Safety Utility

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/path-safety.ts`
- Create: `paperclip-adapter-lmstudio/tests/path-safety.test.ts`

- [ ] **Step 1: Write failing test**

Create `paperclip-adapter-lmstudio/tests/path-safety.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { safePath } from "../src/server/path-safety.js";

describe("safePath", () => {
  it("resolves relative path within cwd", () => {
    const result = safePath("/home/user/project", "src/file.ts");
    expect(result).toBe("/home/user/project/src/file.ts");
  });

  it("blocks path traversal with ..", () => {
    expect(() => safePath("/home/user/project", "../../../etc/passwd"))
      .toThrow(/Path traversal blocked/);
  });

  it("blocks absolute paths outside cwd", () => {
    expect(() => safePath("/home/user/project", "/etc/passwd"))
      .toThrow(/Path traversal blocked/);
  });

  it("allows nested subdirectories", () => {
    const result = safePath("/home/user/project", "a/b/c/file.ts");
    expect(result).toBe("/home/user/project/a/b/c/file.ts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/path-safety.test.ts`
Expected: FAIL — Cannot find module `path-safety`

- [ ] **Step 3: Implement path-safety.ts**

```typescript
import path from "node:path";

export function safePath(cwd: string, relativePath: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, relativePath);
  if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/path-safety.test.ts`
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/path-safety.ts paperclip-adapter-lmstudio/tests/path-safety.test.ts
git commit -m "feat(adapter): add path traversal guard for filesystem tools"
```

---

### Task 2: Tool Definitions

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/tools.ts`
- Create: `paperclip-adapter-lmstudio/tests/tools.test.ts`

- [ ] **Step 1: Write failing test**

Create `paperclip-adapter-lmstudio/tests/tools.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PAPERCLIP_TOOLS } from "../src/server/tools.js";

describe("PAPERCLIP_TOOLS", () => {
  it("defines 18 tools across 3 categories", () => {
    expect(PAPERCLIP_TOOLS.length).toBe(18);
  });

  it("has all tools with OpenAI function calling shape", () => {
    for (const tool of PAPERCLIP_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters.type).toBe("object");
    }
  });

  it("includes all 8 Paperclip API tools", () => {
    const names = PAPERCLIP_TOOLS.map((t) => t.function.name);
    expect(names).toContain("paperclip_get_identity");
    expect(names).toContain("paperclip_get_inbox");
    expect(names).toContain("paperclip_checkout_issue");
    expect(names).toContain("paperclip_update_issue");
    expect(names).toContain("paperclip_add_comment");
    expect(names).toContain("paperclip_get_issue_context");
    expect(names).toContain("paperclip_get_comments");
    expect(names).toContain("paperclip_create_subtask");
  });

  it("includes all 5 filesystem tools", () => {
    const names = PAPERCLIP_TOOLS.map((t) => t.function.name);
    expect(names).toContain("fs_read_file");
    expect(names).toContain("fs_write_file");
    expect(names).toContain("fs_list_directory");
    expect(names).toContain("fs_glob");
    expect(names).toContain("fs_grep");
  });

  it("includes all 5 shell/git tools", () => {
    const names = PAPERCLIP_TOOLS.map((t) => t.function.name);
    expect(names).toContain("shell_exec");
    expect(names).toContain("git_status");
    expect(names).toContain("git_diff");
    expect(names).toContain("git_commit");
    expect(names).toContain("git_log");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tools.ts**

```typescript
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const PAPERCLIP_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "paperclip_get_identity",
      description: "Get the current agent's identity, role, and chain of command.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_inbox",
      description: "Get compact list of tasks assigned to this agent.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_checkout_issue",
      description: "Claim a task for this agent. Must be called before any work.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue UUID" },
          expectedStatuses: {
            type: "array",
            items: { type: "string" },
            description: "Expected current statuses, e.g. ['todo', 'in_review']",
          },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_update_issue",
      description: "Update issue status, priority, or add a comment.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
          },
          comment: { type: "string", description: "Markdown comment" },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_add_comment",
      description: "Add a markdown comment to an issue without changing its status.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          body: { type: "string", description: "Markdown comment content" },
        },
        required: ["issueId", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_issue_context",
      description: "Get compact issue context with ancestors and goal info (no full comment thread).",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_comments",
      description: "Fetch the full comment thread of an issue.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_create_subtask",
      description: "Create a new task (issue) under a parent issue.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          parentId: { type: "string", description: "Parent issue ID" },
          assigneeAgentId: { type: "string" },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress"],
          },
        },
        required: ["title", "parentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_read_file",
      description: "Read a file's content from the agent's working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from cwd" },
          offset: { type: "number", description: "Start line (1-indexed)" },
          limit: { type: "number", description: "Max lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write_file",
      description: "Write content to a file (creates or overwrites).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from cwd" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_list_directory",
      description: "List entries in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path (default: cwd)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_glob",
      description: "Find files by glob pattern (e.g. '**/*.ts').",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Base directory (default: cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_grep",
      description: "Search for a regex pattern in files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "File or directory to search" },
          glob: { type: "string", description: "Filter files by glob (e.g. '*.ts')" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Execute a shell command in the agent's working directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number", description: "Timeout in ms (default 30000, max 120000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show git working tree status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Optional ref/commit to diff against" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage files and create a commit.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Files to add (relative paths)",
          },
          message: { type: "string", description: "Commit message" },
        },
        required: ["files", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent git commits.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits (default 10)" },
        },
      },
    },
  },
];
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/tools.test.ts`
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/tools.ts paperclip-adapter-lmstudio/tests/tools.test.ts
git commit -m "feat(adapter): define OpenAI function schemas for 18 tools"
```

---

### Task 3: Paperclip API Tools

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/paperclip-tools.ts`
- Create: `paperclip-adapter-lmstudio/tests/paperclip-tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executePaperclipTool } from "../src/server/paperclip-tools.js";

const CTX = {
  apiUrl: "http://localhost:3100",
  authToken: "test-token",
  runId: "run-1",
  agentId: "agent-1",
  companyId: "company-1",
};

describe("executePaperclipTool", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("paperclip_get_identity calls /api/agents/me", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "agent-1", name: "CEO" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executePaperclipTool("paperclip_get_identity", {}, CTX);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/agents/me",
      expect.objectContaining({
        headers: expect.objectContaining({ "Authorization": "Bearer test-token" }),
      }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("CEO");
  });

  it("paperclip_checkout_issue includes X-Paperclip-Run-Id header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await executePaperclipTool("paperclip_checkout_issue", { issueId: "iss-1" }, CTX);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-Paperclip-Run-Id"]).toBe("run-1");
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("paperclip_update_issue sends status and comment as PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await executePaperclipTool("paperclip_update_issue", {
      issueId: "iss-1",
      status: "done",
      comment: "Task completed",
    }, CTX);

    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe("PATCH");
    const body = JSON.parse(call[1].body);
    expect(body.status).toBe("done");
    expect(body.comment).toBe("Task completed");
  });

  it("returns error on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: "Conflict",
      text: async () => "Already checked out",
    }));

    const result = await executePaperclipTool("paperclip_checkout_issue", { issueId: "iss-1" }, CTX);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("409");
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await executePaperclipTool("paperclip_get_identity", {}, CTX);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("ECONNREFUSED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/paperclip-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement paperclip-tools.ts**

```typescript
export interface PaperclipContext {
  apiUrl: string;
  authToken: string;
  runId: string;
  agentId: string;
  companyId: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

async function callApi(
  method: string,
  path: string,
  ctx: PaperclipContext,
  body?: unknown,
): Promise<ToolResult> {
  try {
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${ctx.authToken}`,
      "Content-Type": "application/json",
    };
    if (method !== "GET") {
      headers["X-Paperclip-Run-Id"] = ctx.runId;
    }

    const response = await fetch(`${ctx.apiUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      return { content: `HTTP ${response.status}: ${errText}`, isError: true };
    }

    const data = await response.json();
    return { content: JSON.stringify(data), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Network error: ${msg}`, isError: true };
  }
}

export async function executePaperclipTool(
  name: string,
  args: Record<string, unknown>,
  ctx: PaperclipContext,
): Promise<ToolResult> {
  switch (name) {
    case "paperclip_get_identity":
      return callApi("GET", "/api/agents/me", ctx);

    case "paperclip_get_inbox":
      return callApi("GET", "/api/agents/me/inbox-lite", ctx);

    case "paperclip_checkout_issue": {
      const issueId = String(args.issueId);
      const expectedStatuses = Array.isArray(args.expectedStatuses)
        ? args.expectedStatuses
        : ["todo", "backlog", "blocked", "in_review"];
      return callApi("POST", `/api/issues/${issueId}/checkout`, ctx, {
        agentId: ctx.agentId,
        expectedStatuses,
      });
    }

    case "paperclip_update_issue": {
      const issueId = String(args.issueId);
      const body: Record<string, unknown> = {};
      if (args.status) body.status = args.status;
      if (args.comment) body.comment = args.comment;
      if (args.priority) body.priority = args.priority;
      if (args.title) body.title = args.title;
      if (args.description) body.description = args.description;
      return callApi("PATCH", `/api/issues/${issueId}`, ctx, body);
    }

    case "paperclip_add_comment": {
      const issueId = String(args.issueId);
      return callApi("POST", `/api/issues/${issueId}/comments`, ctx, {
        body: String(args.body),
      });
    }

    case "paperclip_get_issue_context": {
      const issueId = String(args.issueId);
      return callApi("GET", `/api/issues/${issueId}/heartbeat-context`, ctx);
    }

    case "paperclip_get_comments": {
      const issueId = String(args.issueId);
      return callApi("GET", `/api/issues/${issueId}/comments`, ctx);
    }

    case "paperclip_create_subtask": {
      return callApi("POST", `/api/companies/${ctx.companyId}/issues`, ctx, {
        title: String(args.title),
        description: args.description ? String(args.description) : undefined,
        parentId: String(args.parentId),
        assigneeAgentId: args.assigneeAgentId ? String(args.assigneeAgentId) : undefined,
        priority: args.priority ? String(args.priority) : "medium",
        status: args.status ? String(args.status) : "todo",
      });
    }

    default:
      return { content: `Unknown Paperclip tool: ${name}`, isError: true };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/paperclip-tools.test.ts`
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/paperclip-tools.ts paperclip-adapter-lmstudio/tests/paperclip-tools.test.ts
git commit -m "feat(adapter): implement Paperclip API tool handlers"
```

---

### Task 4: Filesystem Tools

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/fs-tools.ts`
- Create: `paperclip-adapter-lmstudio/tests/fs-tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeFsTool } from "../src/server/fs-tools.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("executeFsTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "fs-tools-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("fs_write_file writes content and fs_read_file reads it back", async () => {
    const writeResult = await executeFsTool("fs_write_file", {
      path: "hello.txt",
      content: "Hello, World!",
    }, cwd);
    expect(writeResult.isError).toBe(false);

    const readResult = await executeFsTool("fs_read_file", { path: "hello.txt" }, cwd);
    expect(readResult.isError).toBe(false);
    expect(readResult.content).toContain("Hello, World!");
  });

  it("fs_list_directory lists entries", async () => {
    writeFileSync(path.join(cwd, "a.txt"), "a");
    writeFileSync(path.join(cwd, "b.txt"), "b");

    const result = await executeFsTool("fs_list_directory", { path: "." }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("b.txt");
  });

  it("fs_glob finds matching files", async () => {
    mkdirSync(path.join(cwd, "src"));
    writeFileSync(path.join(cwd, "src", "main.ts"), "");
    writeFileSync(path.join(cwd, "src", "util.ts"), "");
    writeFileSync(path.join(cwd, "readme.md"), "");

    const result = await executeFsTool("fs_glob", { pattern: "**/*.ts" }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("main.ts");
    expect(result.content).toContain("util.ts");
    expect(result.content).not.toContain("readme.md");
  });

  it("fs_grep finds pattern in files", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "TODO: fix this\nDone\n");

    const result = await executeFsTool("fs_grep", {
      pattern: "TODO",
      path: ".",
    }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("TODO");
  });

  it("blocks path traversal on fs_read_file", async () => {
    const result = await executeFsTool("fs_read_file", {
      path: "../../../etc/passwd",
    }, cwd);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Path traversal blocked");
  });

  it("blocks path traversal on fs_write_file", async () => {
    const result = await executeFsTool("fs_write_file", {
      path: "../evil.txt",
      content: "x",
    }, cwd);
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/fs-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement fs-tools.ts**

```typescript
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { glob as globPromise } from "node:fs/promises";
import { safePath } from "./path-safety.js";
import type { ToolResult } from "./paperclip-tools.js";

async function readFileHandler(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path));
  const content = await readFile(targetPath, "utf-8");

  let lines = content.split("\n");
  const offset = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
  const limit = typeof args.limit === "number" ? args.limit : lines.length;
  lines = lines.slice(offset, offset + limit);

  return { content: lines.join("\n"), isError: false };
}

async function writeFileHandler(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path));
  await mkdir(dirname(targetPath), { recursive: true });
  const content = String(args.content);
  await writeFile(targetPath, content, "utf-8");
  const size = Buffer.byteLength(content, "utf-8");
  return { content: `File written: ${args.path} (${size} bytes)`, isError: false };
}

async function listDirectoryHandler(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path ?? "."));
  const entries = await readdir(targetPath, { withFileTypes: true });
  const lines = entries.map((e) => {
    const suffix = e.isDirectory() ? "/" : "";
    return `${e.name}${suffix}`;
  });
  return { content: lines.join("\n"), isError: false };
}

async function globHandler(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const basePath = safePath(cwd, String(args.path ?? "."));
  const pattern = String(args.pattern);
  const matches: string[] = [];
  for await (const entry of globPromise(pattern, { cwd: basePath })) {
    matches.push(entry);
  }
  return { content: matches.join("\n"), isError: false };
}

async function grepHandler(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
  const basePath = safePath(cwd, String(args.path ?? "."));
  const pattern = String(args.pattern);
  const globFilter = args.glob ? String(args.glob) : "**/*";
  const regex = new RegExp(pattern);

  const results: string[] = [];
  for await (const entry of globPromise(globFilter, { cwd: basePath })) {
    const fullPath = safePath(basePath, entry);
    try {
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          results.push(`${entry}:${i + 1}: ${line}`);
        }
      });
    } catch {
      // Skip unreadable files
    }
  }

  return { content: results.join("\n") || "(no matches)", isError: false };
}

export async function executeFsTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "fs_read_file": return await readFileHandler(args, cwd);
      case "fs_write_file": return await writeFileHandler(args, cwd);
      case "fs_list_directory": return await listDirectoryHandler(args, cwd);
      case "fs_glob": return await globHandler(args, cwd);
      case "fs_grep": return await grepHandler(args, cwd);
      default:
        return { content: `Unknown fs tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/fs-tools.test.ts`
Expected: 6/6 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/fs-tools.ts paperclip-adapter-lmstudio/tests/fs-tools.test.ts
git commit -m "feat(adapter): implement filesystem tool handlers with path safety"
```

---

### Task 5: Shell & Git Tools

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/shell-tools.ts`
- Create: `paperclip-adapter-lmstudio/tests/shell-tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeShellTool } from "../src/server/shell-tools.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

describe("executeShellTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "shell-tools-test-"));
    execSync("git init -q", { cwd });
    execSync("git config user.email test@test.de", { cwd });
    execSync("git config user.name test", { cwd });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shell_exec runs command in cwd", async () => {
    const result = await executeShellTool("shell_exec", { command: "echo hello" }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello");
  });

  it("shell_exec respects timeout", async () => {
    const result = await executeShellTool("shell_exec", {
      command: "sleep 5",
      timeout: 500,
    }, cwd);
    expect(result.isError).toBe(true);
    expect(result.content.toLowerCase()).toMatch(/timed out|timeout|killed/);
  }, 10000);

  it("shell_exec caps timeout at 120000ms", async () => {
    const result = await executeShellTool("shell_exec", {
      command: "echo quick",
      timeout: 999999,
    }, cwd);
    expect(result.isError).toBe(false);
  });

  it("git_status shows clean tree", async () => {
    const result = await executeShellTool("git_status", {}, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/nothing to commit|working tree clean/);
  });

  it("git_commit stages files and commits", async () => {
    execSync("echo content > file.txt", { cwd });

    const result = await executeShellTool("git_commit", {
      files: ["file.txt"],
      message: "test commit",
    }, cwd);
    expect(result.isError).toBe(false);

    const log = execSync("git log --oneline", { cwd, encoding: "utf-8" });
    expect(log).toContain("test commit");
  });

  it("git_log shows recent commits", async () => {
    execSync("echo x > a.txt && git add a.txt && git commit -q -m 'first'", { cwd, shell: "/bin/bash" });
    execSync("echo y > b.txt && git add b.txt && git commit -q -m 'second'", { cwd, shell: "/bin/bash" });

    const result = await executeShellTool("git_log", { count: 5 }, cwd);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("first");
    expect(result.content).toContain("second");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/shell-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement shell-tools.ts**

```typescript
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolResult } from "./paperclip-tools.js";

const execAsync = promisify(exec);

const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      maxBuffer: MAX_BUFFER,
    });
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { content: combined || "(no output)", isError: false };
  } catch (err: unknown) {
    const e = err as { killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
    if (e.killed || e.signal === "SIGTERM") {
      return { content: `Command timed out after ${timeoutMs}ms`, isError: true };
    }
    const msg = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
    return { content: msg || "Command failed", isError: true };
  }
}

export async function executeShellTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  const timeout = typeof args.timeout === "number" ? args.timeout : DEFAULT_TIMEOUT_MS;

  switch (name) {
    case "shell_exec":
      return runCommand(String(args.command), cwd, timeout);

    case "git_status":
      return runCommand("git status", cwd, timeout);

    case "git_diff": {
      const ref = args.ref ? String(args.ref) : "";
      return runCommand(`git diff ${ref}`.trim(), cwd, timeout);
    }

    case "git_commit": {
      const files = Array.isArray(args.files) ? args.files.map(String) : [];
      const message = String(args.message);
      if (files.length === 0) {
        return { content: "No files specified", isError: true };
      }
      const addCmd = `git add ${files.map((f) => JSON.stringify(f)).join(" ")}`;
      const commitCmd = `git commit -m ${JSON.stringify(message)}`;
      return runCommand(`${addCmd} && ${commitCmd}`, cwd, timeout);
    }

    case "git_log": {
      const count = typeof args.count === "number" ? args.count : 10;
      return runCommand(`git log --oneline -n ${count}`, cwd, timeout);
    }

    default:
      return { content: `Unknown shell tool: ${name}`, isError: true };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/shell-tools.test.ts`
Expected: 6/6 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/shell-tools.ts paperclip-adapter-lmstudio/tests/shell-tools.test.ts
git commit -m "feat(adapter): implement shell and git tool handlers"
```

---

### Task 6: Tool Executor (Dispatcher)

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/tool-executor.ts`
- Create: `paperclip-adapter-lmstudio/tests/tool-executor.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from "vitest";
import { dispatchTool } from "../src/server/tool-executor.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("dispatchTool", () => {
  it("routes paperclip_* tools to paperclip-tools handler", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "agent-1", name: "CEO" }),
    }));

    const result = await dispatchTool({
      name: "paperclip_get_identity",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {
        apiUrl: "http://localhost:3100",
        authToken: "t",
        runId: "r",
        agentId: "a",
        companyId: "c",
      },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("CEO");
  });

  it("routes fs_* tools to fs-tools handler", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "dispatch-test-"));
    try {
      const result = await dispatchTool({
        name: "fs_write_file",
        args: { path: "a.txt", content: "hello" },
        cwd,
        paperclipCtx: {
          apiUrl: "", authToken: "", runId: "", agentId: "", companyId: "",
        },
      });
      expect(result.isError).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns error for unknown tool", async () => {
    const result = await dispatchTool({
      name: "unknown_tool",
      args: {},
      cwd: "/tmp",
      paperclipCtx: {
        apiUrl: "", authToken: "", runId: "", agentId: "", companyId: "",
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/tool-executor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tool-executor.ts**

```typescript
import { executePaperclipTool, PaperclipContext, ToolResult } from "./paperclip-tools.js";
import { executeFsTool } from "./fs-tools.js";
import { executeShellTool } from "./shell-tools.js";

export interface DispatchParams {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  paperclipCtx: PaperclipContext;
}

export async function dispatchTool(params: DispatchParams): Promise<ToolResult> {
  const { name, args, cwd, paperclipCtx } = params;

  if (name.startsWith("paperclip_")) {
    return executePaperclipTool(name, args, paperclipCtx);
  }
  if (name.startsWith("fs_")) {
    return executeFsTool(name, args, cwd);
  }
  if (name.startsWith("shell_") || name.startsWith("git_")) {
    return executeShellTool(name, args, cwd);
  }
  return { content: `Unknown tool: ${name}`, isError: true };
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/tool-executor.test.ts`
Expected: 3/3 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/tool-executor.ts paperclip-adapter-lmstudio/tests/tool-executor.test.ts
git commit -m "feat(adapter): add tool executor dispatcher"
```

---

### Task 7: LLM Client (LM Studio HTTP)

**Files:**
- Create: `paperclip-adapter-lmstudio/src/server/llm-client.ts`
- Create: `paperclip-adapter-lmstudio/tests/llm-client.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { callChatCompletion, streamChatCompletion } from "../src/server/llm-client.js";

describe("callChatCompletion", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("sends tools array and returns parsed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "Hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callChatCompletion({
      url: "http://localhost:1234",
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "test", description: "", parameters: { type: "object", properties: {} } } }],
      timeoutMs: 30000,
    });

    expect(result.message.content).toBe("Hello");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.stream).toBe(false);
    expect(body.tool_choice).toBe("auto");
  });

  it("extracts tool_calls from response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "fs_read_file", arguments: '{"path":"a.txt"}' },
            }],
          },
        }],
      }),
    }));

    const result = await callChatCompletion({
      url: "http://localhost:1234",
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 30000,
    });

    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls![0].function.name).toBe("fs_read_file");
  });

  it("returns error on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }));

    await expect(callChatCompletion({
      url: "http://localhost:1234",
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 30000,
    })).rejects.toThrow(/500/);
  });
});

describe("streamChatCompletion", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("streams tokens via onToken callback", async () => {
    const sseBody = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n';
    const mockBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));

    const tokens: string[] = [];
    const fullText = await streamChatCompletion({
      url: "http://localhost:1234",
      model: "m",
      messages: [],
      timeoutMs: 30000,
      onToken: async (t) => { tokens.push(t); },
    });

    expect(tokens).toEqual(["He", "llo"]);
    expect(fullText).toBe("Hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/llm-client.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement llm-client.ts**

```typescript
export interface ToolCallInResponse {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCallInResponse[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCallInResponse[];
  tool_call_id?: string;
  name?: string;
}

export interface CompletionRequest {
  url: string;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  timeoutMs: number;
}

export interface CompletionResponse {
  message: AssistantMessage;
  usage?: { inputTokens: number; outputTokens: number };
}

export async function callChatCompletion(req: CompletionRequest): Promise<CompletionResponse> {
  const response = await fetch(`${req.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      tool_choice: "auto",
      stream: false,
    }),
    signal: AbortSignal.timeout(req.timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`LM Studio API error ${response.status}: ${text}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: AssistantMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const message = data.choices[0]?.message;
  if (!message) throw new Error("No message in response");

  return {
    message,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined,
  };
}

export interface StreamRequest {
  url: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
  onToken: (token: string) => Promise<void>;
}

export async function streamChatCompletion(req: StreamRequest): Promise<string> {
  const response = await fetch(`${req.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
    }),
    signal: AbortSignal.timeout(req.timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`LM Studio stream error ${response.status}: ${text}`);
  }

  const body = response.body;
  if (!body) throw new Error("No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            fullText += token;
            await req.onToken(token);
          }
        } catch {
          // Skip malformed SSE
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/llm-client.test.ts`
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/llm-client.ts paperclip-adapter-lmstudio/tests/llm-client.test.ts
git commit -m "feat(adapter): add LM Studio HTTP client with tool support"
```

---

### Task 8: Agent Loop (execute.ts rewrite)

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/server/execute.ts` (replace entire file)
- Modify: `paperclip-adapter-lmstudio/tests/execute.test.ts` (rewrite tests)

- [ ] **Step 1: Rewrite tests**

Replace `paperclip-adapter-lmstudio/tests/execute.test.ts` entirely:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../src/server/execute.js";

function makeCtx(overrides: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "lmstudio_local",
      adapterConfig: {},
    },
    config: {
      url: "http://localhost:1234",
      defaultModel: "gemma-4-31b-it",
      timeoutMs: 30000,
      maxIterations: 5,
      ...overrides,
    },
    context: { paperclipApiUrl: "http://localhost:3100", ...context },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

describe("execute (agent loop)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns immediately when LLM returns text without tool_calls", async () => {
    const streamBody = 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n';
    const mockBody = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(streamBody)); c.close(); },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: mockBody });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Done");
  });

  it("executes tool_call and loops back", async () => {
    const streamBody = 'data: {"choices":[{"delta":{"content":"Finished"}}]}\n\ndata: [DONE]\n\n';
    const mockBody = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(streamBody)); c.close(); },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "paperclip_get_identity", arguments: "{}" },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "agent-1", name: "CEO" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Got identity" } }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: mockBody });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(ctx.logs.some((l) => l.includes("paperclip_get_identity"))).toBe(true);
    expect(ctx.logs.some((l) => l.includes("tool_result"))).toBe(true);
  });

  it("stops at maxIterations", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `call_${callCount}`,
                type: "function",
                function: { name: "paperclip_get_identity", arguments: "{}" },
              }],
            },
          }],
        }),
      };
    }));

    const ctx = makeCtx({ maxIterations: 3 });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Max iterations");
  });

  it("returns error when no model configured", async () => {
    const ctx = makeCtx({ defaultModel: "" });
    const result = await execute(ctx as any);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("no_model");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/execute.test.ts`
Expected: FAIL (old execute.ts doesn't support tool loop)

- [ ] **Step 3: Rewrite execute.ts**

Replace entire `paperclip-adapter-lmstudio/src/server/execute.ts`:

```typescript
import { callChatCompletion, streamChatCompletion, ChatMessage } from "./llm-client.js";
import { dispatchTool } from "./tool-executor.js";
import { PAPERCLIP_TOOLS } from "./tools.js";
import type { PaperclipContext } from "./paperclip-tools.js";

interface ExecutionContext {
  runId: string;
  agent: {
    id: string;
    companyId: string;
    name: string;
    adapterType: string | null;
    adapterConfig: unknown;
  };
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  runtime: {
    sessionId: string | null;
    sessionParams: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    taskKey: string | null;
  };
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  authToken?: string;
}

interface ExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  model?: string | null;
  provider?: string | null;
  summary?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
}

function asString(val: unknown, fallback: string): string {
  return typeof val === "string" ? val : fallback;
}

function asNumber(val: unknown, fallback: number): number {
  return typeof val === "number" ? val : fallback;
}

function buildSystemPrompt(agent: ExecutionContext["agent"], context: Record<string, unknown>): string {
  const parts: string[] = [
    `You are ${agent.name}, a Paperclip AI agent.`,
    `Your agent ID is ${agent.id}. Your company ID is ${agent.companyId}.`,
    "",
    "You have access to tools in three categories:",
    "- Paperclip API: manage issues, comments, subtasks (paperclip_*)",
    "- File System: read, write, search files (fs_*)",
    "- Shell & Git: execute commands, git operations (shell_exec, git_*)",
    "",
    "Follow the Paperclip heartbeat procedure:",
    "1. Always checkout an issue before working on it (paperclip_checkout_issue).",
    "2. Read relevant context (paperclip_get_issue_context, paperclip_get_comments).",
    "3. Do the work using the appropriate tools.",
    "4. Update the issue status and add a summary comment (paperclip_update_issue).",
    "5. Return a short text summary when done.",
  ];

  const instructions = asString(context.agentInstructions, "");
  if (instructions) {
    parts.push("", "## Agent Instructions", instructions);
  }

  return parts.join("\n");
}

function buildUserPrompt(context: Record<string, unknown>): string {
  const parts: string[] = [];

  const wake = context.paperclipWake as Record<string, unknown> | undefined;
  if (wake) {
    const reason = asString(wake.reason, "unknown");
    const issue = wake.issue as Record<string, unknown> | undefined;
    const issueId = asString(issue?.identifier, asString(issue?.id, "unknown"));
    const issueTitle = asString(issue?.title, "");
    const issueDescription = asString(issue?.description, "");

    parts.push("## Paperclip Wake");
    parts.push(`- reason: ${reason}`);
    parts.push(`- issue: ${issueId}${issueTitle ? ` — ${issueTitle}` : ""}`);
    if (issueDescription) parts.push(`\n### Description\n\n${issueDescription}`);

    const comments = wake.comments as Array<Record<string, unknown>> | undefined;
    if (comments && comments.length > 0) {
      parts.push("\n### Recent Comments\n");
      for (const c of comments) {
        const author = asString(c.authorAgentName, asString(c.authorUserId, "unknown"));
        parts.push(`**${author}:** ${asString(c.body, "")}\n`);
      }
    }
  }

  const promptTemplate = asString(context.renderedPromptTemplate, "");
  if (promptTemplate) parts.push(promptTemplate);

  return parts.join("\n") || "Continue with your current task.";
}

async function logEvent(
  onLog: ExecutionContext["onLog"],
  event: Record<string, unknown>,
): Promise<void> {
  await onLog("stdout", JSON.stringify(event) + "\n");
}

export async function execute(ctx: ExecutionContext): Promise<ExecutionResult> {
  const config = ctx.config;
  const url = asString(config.url, "http://localhost:1234");
  const model = asString(config.model, "") || asString(config.defaultModel, "");
  const timeoutMs = asNumber(config.timeoutMs, 120000);
  const maxIterations = asNumber(config.maxIterations, 25);

  if (!model) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "No model configured. Set 'defaultModel' in adapter config.",
      errorCode: "no_model",
    };
  }

  const paperclipApiUrl = asString(ctx.context.paperclipApiUrl, "http://localhost:3100");
  const cwd = asString(ctx.context.cwd, asString(ctx.config.cwd, process.cwd()));

  const paperclipCtx: PaperclipContext = {
    apiUrl: paperclipApiUrl,
    authToken: ctx.authToken ?? "",
    runId: ctx.runId,
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
  };

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(ctx.agent, ctx.context) },
    { role: "user", content: buildUserPrompt(ctx.context) },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let finalSummary = "";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response;
    try {
      response = await callChatCompletion({
        url,
        model,
        messages,
        tools: PAPERCLIP_TOOLS,
        timeoutMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        signal: null,
        timedOut: msg.includes("timeout") || msg.includes("Abort"),
        errorMessage: `LLM call failed: ${msg}`,
        errorCode: "llm_error",
      };
    }

    if (response.usage) {
      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
    }

    const msg = response.message;
    messages.push(msg as ChatMessage);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Final text answer — stream it
      const textMessages = messages.slice(0, -1);
      if (msg.content) {
        textMessages.push({ role: "user", content: "Repeat your final answer to me." });
      }

      try {
        finalSummary = await streamChatCompletion({
          url,
          model,
          messages: [
            ...messages.slice(0, -1),
            { role: "user", content: "Repeat your previous final answer to me verbatim." },
          ],
          timeoutMs,
          onToken: async (token) => {
            await ctx.onLog("stdout", token);
          },
        });
      } catch {
        // Fallback: use the non-streamed content
        finalSummary = msg.content ?? "";
        if (finalSummary) {
          await ctx.onLog("stdout", finalSummary);
        }
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        model,
        provider: "lmstudio",
        summary: finalSummary.slice(0, 500),
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    }

    // Execute tool calls
    for (const toolCall of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }

      await logEvent(ctx.onLog, {
        kind: "tool_call",
        name: toolCall.function.name,
        input: args,
        toolUseId: toolCall.id,
      });

      const result = await dispatchTool({
        name: toolCall.function.name,
        args,
        cwd,
        paperclipCtx,
      });

      await logEvent(ctx.onLog, {
        kind: "tool_result",
        toolUseId: toolCall.id,
        toolName: toolCall.function.name,
        content: result.content,
        isError: result.isError,
      });

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: result.isError ? `Error: ${result.content}` : result.content,
      });
    }
  }

  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: `Max iterations (${maxIterations}) reached without final answer`,
    errorCode: "max_iterations",
    model,
    provider: "lmstudio",
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/execute.test.ts`
Expected: 4/4 PASS

- [ ] **Step 5: Run full test suite**

Run: `cd paperclip-adapter-lmstudio && npx vitest run`
Expected: All tests pass across all files

- [ ] **Step 6: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/execute.ts paperclip-adapter-lmstudio/tests/execute.test.ts
git commit -m "feat(adapter): implement agent loop with tool-use for LM Studio"
```

---

### Task 9: UI Parser Extension

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/ui-parser.ts`
- Modify: `paperclip-adapter-lmstudio/tests/ui-parser.test.ts`

- [ ] **Step 1: Add tests for tool events**

Append to `paperclip-adapter-lmstudio/tests/ui-parser.test.ts`:

```typescript
describe("createStdoutParser — tool events", () => {
  it("parses tool_call JSON lines", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      kind: "tool_call",
      name: "fs_write_file",
      input: { path: "a.txt", content: "x" },
      toolUseId: "call_1",
    });
    const entries = parser.parseLine(line, "2026-04-18T12:00:00Z");
    expect(entries).toEqual([
      {
        kind: "tool_call",
        ts: "2026-04-18T12:00:00Z",
        name: "fs_write_file",
        input: { path: "a.txt", content: "x" },
        toolUseId: "call_1",
      },
    ]);
  });

  it("parses tool_result JSON lines", () => {
    const parser = createStdoutParser();
    const line = JSON.stringify({
      kind: "tool_result",
      toolUseId: "call_1",
      toolName: "fs_write_file",
      content: "File written: a.txt",
      isError: false,
    });
    const entries = parser.parseLine(line, "2026-04-18T12:00:00Z");
    expect(entries[0].kind).toBe("tool_result");
    expect(entries[0]).toMatchObject({
      toolUseId: "call_1",
      toolName: "fs_write_file",
      content: "File written: a.txt",
      isError: false,
    });
  });

  it("treats non-JSON as assistant text", () => {
    const parser = createStdoutParser();
    const entries = parser.parseLine("Hello world", "2026-04-18T12:00:00Z");
    expect(entries[0].kind).toBe("assistant");
    expect(entries[0].text).toBe("Hello world");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/ui-parser.test.ts`
Expected: FAIL for new tool event tests

- [ ] **Step 3: Update ui-parser.ts**

Replace `paperclip-adapter-lmstudio/src/ui-parser.ts`:

```typescript
interface TranscriptEntry {
  kind: string;
  ts: string;
  text?: string;
  delta?: boolean;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  toolName?: string;
  content?: string;
  isError?: boolean;
}

export function createStdoutParser() {
  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    // Try JSON parse for structured events
    if (trimmed.startsWith("{")) {
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event === "object" && typeof event.kind === "string") {
          return [{ ...event, ts }];
        }
      } catch {
        // Not valid JSON — fall through
      }
    }

    return [{ kind: "assistant", ts, text: trimmed, delta: true }];
  }

  function reset() {
    // No state to reset
  }

  return { parseLine, reset };
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-adapter-lmstudio && npx vitest run tests/ui-parser.test.ts`
Expected: 6/6 PASS (3 original + 3 new)

- [ ] **Step 5: Commit**

```bash
git add paperclip-adapter-lmstudio/src/ui-parser.ts paperclip-adapter-lmstudio/tests/ui-parser.test.ts
git commit -m "feat(adapter): extend UI parser for tool_call and tool_result events"
```

---

### Task 10: Config Schema Update

**Files:**
- Modify: `paperclip-adapter-lmstudio/src/server/index.ts`

- [ ] **Step 1: Add maxIterations field to schema**

Modify the `getConfigSchema` function in `paperclip-adapter-lmstudio/src/server/index.ts`. Find the `fields` array and add after the existing fields:

```typescript
// After streamingEnabled field, add:
{
  key: "maxIterations",
  label: "Max Tool-Iterationen",
  type: "number" as const,
  default: 25,
  hint: "Maximale Anzahl Tool-Aufrufe pro Heartbeat (Sicherheitslimit)",
},
```

Full current schema array should end with:

```typescript
return {
  version: 1,
  fields: [
    {
      key: "url",
      label: "LM Studio URL",
      type: "text" as const,
      required: true,
      default: "http://localhost:1234",
      hint: "URL des LM Studio Servers",
    },
    {
      key: "defaultModel",
      label: "Modell",
      type: "select" as const,
      required: true,
      hint: "LLM-Modell aus LM Studio",
      options: modelOptions.length > 0
        ? modelOptions
        : [{ value: "", label: "(LM Studio nicht erreichbar)" }],
    },
    {
      key: "timeoutMs",
      label: "Timeout (ms)",
      type: "number" as const,
      default: 120000,
      hint: "Timeout für Inferenz in Millisekunden",
    },
    {
      key: "streamingEnabled",
      label: "Token-Streaming",
      type: "boolean" as const,
      default: true,
      hint: "Antwort Token für Token in der UI anzeigen",
    },
    {
      key: "maxIterations",
      label: "Max Tool-Iterationen",
      type: "number" as const,
      default: 25,
      hint: "Maximale Anzahl Tool-Aufrufe pro Heartbeat (Sicherheitslimit)",
    },
  ],
};
```

Also update the `ConfigSchemaField` interface to accept `number` in the default:

```typescript
interface ConfigSchemaField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "select";
  required?: boolean;
  default?: unknown;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
}
```

(The interface already uses `unknown` for default, so no change needed there.)

- [ ] **Step 2: Build**

Run: `cd paperclip-adapter-lmstudio && pnpm build`
Expected: Compiles without errors

- [ ] **Step 3: Commit**

```bash
git add paperclip-adapter-lmstudio/src/server/index.ts
git commit -m "feat(adapter): add maxIterations field to config schema"
```

---

### Task 11: Integration & End-to-End Smoke Test

**Files:**
- Create: `paperclip-adapter-lmstudio/tests/integration.test.ts` (extend existing)

- [ ] **Step 1: Add integration test for full adapter**

Append to `paperclip-adapter-lmstudio/tests/integration.test.ts`:

```typescript
import { PAPERCLIP_TOOLS } from "../src/server/tools.js";

describe("adapter integration — tool use", () => {
  it("createServerAdapter returns adapter with getConfigSchema including maxIterations", async () => {
    const adapter = createServerAdapter();
    expect(adapter.getConfigSchema).toBeDefined();
    const schema = await adapter.getConfigSchema!();
    const keys = schema.fields.map((f: any) => f.key);
    expect(keys).toContain("url");
    expect(keys).toContain("defaultModel");
    expect(keys).toContain("maxIterations");
  });

  it("PAPERCLIP_TOOLS is used by execute", () => {
    expect(PAPERCLIP_TOOLS.length).toBe(18);
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `cd paperclip-adapter-lmstudio && npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Build the adapter**

Run: `cd paperclip-adapter-lmstudio && pnpm build`
Expected: `dist/` updated

- [ ] **Step 4: Reload adapter in running Paperclip server**

```bash
TOKEN=$(cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip" && npx paperclipai auth token)
curl -s -X POST "http://localhost:3100/api/adapters/lmstudio_local/reload" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

Expected: `{ "type": "lmstudio_local", "reloaded": true }`

- [ ] **Step 5: Verify schema includes maxIterations**

```bash
TOKEN=$(cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip" && npx paperclipai auth token)
curl -s "http://localhost:3100/api/adapters/lmstudio_local/config-schema" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep maxIterations
```

Expected: Shows `"key": "maxIterations"` in output

- [ ] **Step 6: Commit**

```bash
git add paperclip-adapter-lmstudio/tests/integration.test.ts
git commit -m "test(adapter): add integration tests for tool-use adapter"
```

---

### Task 12: Manual End-to-End Test

**Files:** (no new files, just manual verification)

- [ ] **Step 1: Load a small model in LM Studio**

Ensure at least `gemma-4-31b-it` is loaded in LM Studio (already in user's setup).

- [ ] **Step 2: Create a test task in Paperclip**

Via CLI:

```bash
cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip"
npx paperclipai issue create \
  --company-id 9cebf3cf-efe8-4597-a400-f06488900a87 \
  --title "Tool-Use Test: List files in workspace" \
  --description "Please run fs_list_directory on '.' and report what you see." \
  --status todo \
  --assignee-agent-id 506c873e-3a40-4483-9a45-0eb0fa1554bb
```

Capture the issue ID from output.

- [ ] **Step 3: Switch CEO to LM Studio adapter**

```bash
TOKEN=$(cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip" && npx paperclipai auth token)
curl -s -X PATCH "http://localhost:3100/api/agents/506c873e-3a40-4483-9a45-0eb0fa1554bb" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adapterType":"lmstudio_local","adapterConfig":{"url":"http://localhost:1234","defaultModel":"gemma-4-31b-it","timeoutMs":180000,"streamingEnabled":true,"maxIterations":10}}'
```

- [ ] **Step 4: Trigger heartbeat**

```bash
cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip"
npx paperclipai heartbeat run --agent-id 506c873e-3a40-4483-9a45-0eb0fa1554bb
```

- [ ] **Step 5: Verify in Paperclip UI**

Open the issue in the web UI. Expected to see:
- Tool calls rendered (e.g., `paperclip_checkout_issue`, `fs_list_directory`)
- Tool results rendered
- Final assistant text answer

- [ ] **Step 6: Switch CEO back to Claude**

```bash
TOKEN=$(cd "/Users/walterschoenenbroecher.de/Desktop/Claude Code/Paperclip" && npx paperclipai auth token)
curl -s -X PATCH "http://localhost:3100/api/agents/506c873e-3a40-4483-9a45-0eb0fa1554bb" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"adapterType":"claude_local"}'
```

- [ ] **Step 7: Document findings**

Based on the test run, update `paperclip-adapter-lmstudio/README.md` with:
- Which models work well with tool-use (function calling support varies)
- Recommended `maxIterations` settings
- Known limitations (e.g., specific model quirks)

```bash
git add paperclip-adapter-lmstudio/README.md
git commit -m "docs(adapter): document tool-use test results and model recommendations"
```
