# Document Opener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local HTTP helper (macOS + Windows) that opens or reveals local files referenced by absolute paths in Paperclip Markdown links, triggered via two inline icon buttons next to each detected link.

**Architecture:** Standalone helper daemon in `scripts/document-opener/` (workspace-member, zero npm deps in runtime, only built-in Node modules). UI integration via new `local-document.ts` helpers and a `LocalDocumentLink` component plugged into `MarkdownBody.tsx`'s `a`-renderer. Auto-start via launchd (macOS) and Task Scheduler (Windows), installed by a single cross-platform Node installer.

**Tech Stack:** Node 22 (built-ins: `node:http`, `node:fs`, `node:path`, `node:child_process`, `node:os`), TypeScript, vitest 3, React 19, react-markdown 10, lucide-react.

**Spec:** [docs/superpowers/specs/2026-05-13-document-opener-design.md](../specs/2026-05-13-document-opener-design.md)

---

## Task 1: Scaffold `scripts/document-opener/` as workspace member

**Files:**
- Create: `scripts/document-opener/package.json`
- Create: `scripts/document-opener/tsconfig.json`
- Create: `scripts/document-opener/vitest.config.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Create `scripts/document-opener/package.json`**

```json
{
  "name": "@paperclipai/document-opener",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "esbuild src/server.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "install:agent": "node install.js"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.27.3",
    "typescript": "^5.5.0",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: Create `scripts/document-opener/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ES2022"]
  },
  "include": ["src/**/*", "tests/**/*", "install.js"]
}
```

- [ ] **Step 3: Create `scripts/document-opener/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "document-opener",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Add `scripts/document-opener` to `pnpm-workspace.yaml`**

Open `pnpm-workspace.yaml` and add the line `  - scripts/document-opener` under the `packages:` key, alphabetically before `  - server`:

```yaml
packages:
  - packages/*
  - packages/adapters/*
  - packages/plugins/*
  - "!packages/plugins/sandbox-providers/**"
  - packages/plugins/examples/*
  - "!packages/plugins/examples/plugin-orchestration-smoke-example"
  - scripts/document-opener
  - server
  - ui
  - cli
```

- [ ] **Step 5: Add `scripts/document-opener` to root `vitest.config.ts` projects**

Open `vitest.config.ts` (the one in repo root) and add `"scripts/document-opener"` to the `projects` array, alphabetically before `"server"`:

```typescript
projects: [
  "packages/shared",
  "packages/db",
  "packages/adapter-utils",
  "packages/adapters/acpx-local",
  "packages/adapters/claude-local",
  "packages/adapters/codex-local",
  "packages/adapters/cursor-local",
  "packages/adapters/gemini-local",
  "packages/adapters/opencode-local",
  "packages/adapters/pi-local",
  "scripts/document-opener",
  "server",
  "ui",
  "cli",
],
```

- [ ] **Step 6: Install workspace dependencies**

Run: `pnpm install`
Expected: `+ @paperclipai/document-opener 0.1.0 <- scripts/document-opener` and no errors.

- [ ] **Step 7: Commit**

```bash
git add scripts/document-opener/ pnpm-workspace.yaml vitest.config.ts pnpm-lock.yaml
git commit -m "feat(document-opener): scaffold workspace package"
```

---

## Task 2: Path validation core (TDD)

**Files:**
- Create: `scripts/document-opener/src/validate-path.ts`
- Create: `scripts/document-opener/tests/validate-path.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/document-opener/tests/validate-path.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validatePath, ValidationError } from "../src/validate-path";

describe("validatePath", () => {
  let tmpRoot: string;
  let allowedRoot: string;
  let outsideRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "doc-opener-test-"));
    allowedRoot = join(tmpRoot, "allowed");
    outsideRoot = join(tmpRoot, "outside");
    mkdirSync(allowedRoot);
    mkdirSync(outsideRoot);
    writeFileSync(join(allowedRoot, "doc.md"), "hello");
    writeFileSync(join(outsideRoot, "secret.md"), "secret");
  });

  afterEach(() => {
    // tmp dirs auto-cleaned on process exit; OS-level cleanup is enough
  });

  it("accepts a file inside an allowed root", () => {
    const result = validatePath(join(allowedRoot, "doc.md"), [allowedRoot]);
    expect(result).toBe(join(allowedRoot, "doc.md"));
  });

  it("rejects a file outside all allowed roots", () => {
    expect(() => validatePath(join(outsideRoot, "secret.md"), [allowedRoot]))
      .toThrow(ValidationError);
  });

  it("rejects a non-existent file", () => {
    expect(() => validatePath(join(allowedRoot, "nope.md"), [allowedRoot]))
      .toThrow(/file not found/i);
  });

  it("rejects ..-escape attempts (after resolve+realpath)", () => {
    const escape = join(allowedRoot, "..", "outside", "secret.md");
    expect(() => validatePath(escape, [allowedRoot]))
      .toThrow(/outside allowed roots/i);
  });

  it("rejects a symlink that points outside allowed roots", () => {
    const symlinkPath = join(allowedRoot, "trap.md");
    symlinkSync(join(outsideRoot, "secret.md"), symlinkPath);
    expect(() => validatePath(symlinkPath, [allowedRoot]))
      .toThrow(/outside allowed roots/i);
  });

  it("expands ~ to home dir", () => {
    // Use HOME-resident temp dir for this case
    process.env.HOME = tmpRoot;
    const result = validatePath("~/allowed/doc.md", [allowedRoot]);
    expect(result).toBe(join(allowedRoot, "doc.md"));
  });

  it("decodes URL-encoded paths", () => {
    const spaceDir = join(allowedRoot, "with space");
    mkdirSync(spaceDir);
    writeFileSync(join(spaceDir, "doc.md"), "hi");
    const encoded = join(allowedRoot, "with%20space", "doc.md");
    const result = validatePath(encoded, [allowedRoot]);
    expect(result).toBe(join(spaceDir, "doc.md"));
  });

  it("strips file:// prefix", () => {
    const fileUrl = `file://${join(allowedRoot, "doc.md")}`;
    const result = validatePath(fileUrl, [allowedRoot]);
    expect(result).toBe(join(allowedRoot, "doc.md"));
  });

  it("returns ValidationError with .code property", () => {
    try {
      validatePath(join(outsideRoot, "secret.md"), [allowedRoot]);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("OUTSIDE_ROOTS");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: All tests FAIL with "Cannot find module '../src/validate-path'".

- [ ] **Step 3: Implement `validatePath`**

Create `scripts/document-opener/src/validate-path.ts`:

```typescript
import { realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { resolve, sep } from "node:path";

export type ValidationCode =
  | "NOT_FOUND"
  | "OUTSIDE_ROOTS"
  | "BAD_PATH";

export class ValidationError extends Error {
  constructor(public code: ValidationCode, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function expandTilde(input: string): string {
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    return homedir() + input.slice(1);
  }
  return input;
}

function expandWindowsEnv(input: string): string {
  if (platform() !== "win32") return input;
  // %USERPROFILE%, %APPDATA%, %LOCALAPPDATA% — restricted allowlist
  const ALLOWED = ["USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  return input.replace(/%([^%]+)%/g, (match, name) => {
    if (!ALLOWED.includes(name)) return match;
    const value = process.env[name];
    return value ?? match;
  });
}

function stripFileScheme(input: string): string {
  if (input.startsWith("file:///")) return input.slice(7);
  if (input.startsWith("file://")) return input.slice(6);
  return input;
}

function decodeUrl(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function pathsEqualOrInside(child: string, parent: string): boolean {
  const isWin = platform() === "win32";
  const a = isWin ? child.toLowerCase() : child;
  const b = isWin ? parent.toLowerCase() : parent;
  if (a === b) return true;
  const prefix = b.endsWith(sep) ? b : b + sep;
  return a.startsWith(prefix);
}

export function validatePath(rawPath: string, roots: string[]): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new ValidationError("BAD_PATH", "path is empty");
  }

  let working = rawPath;
  working = stripFileScheme(working);
  working = decodeUrl(working);
  working = expandTilde(working);
  working = expandWindowsEnv(working);
  const resolved = resolve(working);

  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    throw new ValidationError("NOT_FOUND", `file not found: ${rawPath}`);
  }

  try {
    statSync(realPath);
  } catch {
    throw new ValidationError("NOT_FOUND", `file not found: ${rawPath}`);
  }

  const realRoots = roots.map((root) => {
    const expanded = expandWindowsEnv(expandTilde(root));
    return realpathSync(resolve(expanded));
  });

  const ok = realRoots.some((root) => pathsEqualOrInside(realPath, root));
  if (!ok) {
    throw new ValidationError(
      "OUTSIDE_ROOTS",
      `path outside allowed roots: ${rawPath}`,
    );
  }

  return realPath;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/document-opener/src/validate-path.ts scripts/document-opener/tests/validate-path.test.ts
git commit -m "feat(document-opener): path validation with symlink+escape protection"
```

---

## Task 3: Config loader

**Files:**
- Create: `scripts/document-opener/src/config.ts`
- Create: `scripts/document-opener/tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/document-opener/tests/config.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, DEFAULT_PORT, DEFAULT_ALLOWED_ORIGINS } from "../src/config";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doc-opener-cfg-"));
  });

  it("returns null when the config file does not exist", () => {
    const result = loadConfig(join(tmpDir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns null when the config file is malformed JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not json");
    const result = loadConfig(path);
    expect(result).toBeNull();
  });

  it("returns null when roots field is missing", () => {
    const path = join(tmpDir, "noroots.json");
    writeFileSync(path, JSON.stringify({ port: 19327 }));
    const result = loadConfig(path);
    expect(result).toBeNull();
  });

  it("returns null when roots is empty array", () => {
    const path = join(tmpDir, "empty.json");
    writeFileSync(path, JSON.stringify({ roots: [] }));
    const result = loadConfig(path);
    expect(result).toBeNull();
  });

  it("loads valid config with all fields", () => {
    const path = join(tmpDir, "ok.json");
    const data = {
      port: 12345,
      roots: ["/Users/foo", "~/bar"],
      allowedOrigins: ["http://example.com"],
    };
    writeFileSync(path, JSON.stringify(data));
    const result = loadConfig(path);
    expect(result).toEqual(data);
  });

  it("applies defaults for missing optional fields", () => {
    const path = join(tmpDir, "minimal.json");
    writeFileSync(path, JSON.stringify({ roots: ["/Users/foo"] }));
    const result = loadConfig(path);
    expect(result).toEqual({
      port: DEFAULT_PORT,
      roots: ["/Users/foo"],
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: FAIL — `loadConfig` not found.

- [ ] **Step 3: Implement `loadConfig`**

Create `scripts/document-opener/src/config.ts`:

```typescript
import { readFileSync } from "node:fs";

export const DEFAULT_PORT = 19327;
export const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
  "https://company.whitestag.ai",
];

export interface HelperConfig {
  port: number;
  roots: string[];
  allowedOrigins: string[];
}

export function loadConfig(path: string): HelperConfig | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.roots) || obj.roots.length === 0) return null;
  const roots = obj.roots.filter((r): r is string => typeof r === "string");
  if (roots.length === 0) return null;

  const port =
    typeof obj.port === "number" && Number.isFinite(obj.port)
      ? obj.port
      : DEFAULT_PORT;

  const allowedOrigins = Array.isArray(obj.allowedOrigins)
    ? obj.allowedOrigins.filter((o): o is string => typeof o === "string")
    : DEFAULT_ALLOWED_ORIGINS;

  return {
    port,
    roots,
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: All 6 config tests PASS, plus the 9 validate-path tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/document-opener/src/config.ts scripts/document-opener/tests/config.test.ts
git commit -m "feat(document-opener): config loader with defaults"
```

---

## Task 4: Platform dispatch (open/reveal commands)

**Files:**
- Create: `scripts/document-opener/src/platform.ts`
- Create: `scripts/document-opener/tests/platform.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/document-opener/tests/platform.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { openArgs, revealArgs } from "../src/platform";

describe("platform dispatch", () => {
  it("openArgs darwin → open <path>", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(openArgs("/Users/foo/x.md")).toEqual({
      cmd: "open",
      args: ["/Users/foo/x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("openArgs win32 → cmd /c start \"\" <path>", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(openArgs("C:\\foo\\x.md")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "C:\\foo\\x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("revealArgs darwin → open -R <path>", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    expect(revealArgs("/Users/foo/x.md")).toEqual({
      cmd: "open",
      args: ["-R", "/Users/foo/x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("revealArgs win32 → explorer /select,<path>", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    expect(revealArgs("C:\\foo\\x.md")).toEqual({
      cmd: "explorer.exe",
      args: ["/select,C:\\foo\\x.md"],
    });
    vi.unstubAllGlobals();
  });

  it("throws on unsupported platform", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    expect(() => openArgs("/x")).toThrow(/unsupported/i);
    expect(() => revealArgs("/x")).toThrow(/unsupported/i);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: FAIL — `openArgs`/`revealArgs` not found.

- [ ] **Step 3: Implement platform dispatch**

Create `scripts/document-opener/src/platform.ts`:

```typescript
export interface CommandSpec {
  cmd: string;
  args: string[];
}

export function openArgs(path: string): CommandSpec {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", args: [path] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", "", path] };
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function revealArgs(path: string): CommandSpec {
  switch (process.platform) {
    case "darwin":
      return { cmd: "open", args: ["-R", path] };
    case "win32":
      return { cmd: "explorer.exe", args: [`/select,${path}`] };
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: 5 platform tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/document-opener/src/platform.ts scripts/document-opener/tests/platform.test.ts
git commit -m "feat(document-opener): platform-aware open/reveal command dispatch"
```

---

## Task 5: HTTP server with /health endpoint

**Files:**
- Create: `scripts/document-opener/src/server.ts`
- Create: `scripts/document-opener/tests/server-health.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/document-opener/tests/server-health.test.ts`:

```typescript
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../src/server";

describe("server /health", () => {
  let running: RunningServer;

  afterEach(async () => {
    await running?.close();
  });

  async function startWith(config: Parameters<typeof createServer>[0]["config"]) {
    running = await createServer({ config, port: 0 });
    const addr = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  it("returns 503 when config is null", async () => {
    const base = await startWith(null);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not configured" });
  });

  it("returns 200 with roots when config is valid", async () => {
    const base = await startWith({
      port: 0,
      roots: ["/Users/foo"],
      allowedOrigins: ["http://localhost:3100"],
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      version: "1",
      roots: ["/Users/foo"],
    });
  });

  it("returns 404 for unknown route", async () => {
    const base = await startWith({
      port: 0,
      roots: ["/Users/foo"],
      allowedOrigins: ["http://localhost:3100"],
    });
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("binds to 127.0.0.1 only", async () => {
    const base = await startWith({
      port: 0,
      roots: ["/Users/foo"],
      allowedOrigins: ["http://localhost:3100"],
    });
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: FAIL — `createServer` not found.

- [ ] **Step 3: Implement minimal HTTP server**

Create `scripts/document-opener/src/server.ts`:

```typescript
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HelperConfig } from "./config.js";

export interface RunningServer {
  server: Server;
  close: () => Promise<void>;
}

export interface CreateServerOptions {
  config: HelperConfig | null;
  port: number;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleHealth(config: HelperConfig | null, res: ServerResponse) {
  if (!config) {
    send(res, 503, { error: "not configured" });
    return;
  }
  send(res, 200, {
    ok: true,
    version: "1",
    roots: config.roots,
  });
}

export async function createServer(options: CreateServerOptions): Promise<RunningServer> {
  const { config, port } = options;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/health") {
      handleHealth(config, res);
      return;
    }
    send(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: All 4 server-health tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/document-opener/src/server.ts scripts/document-opener/tests/server-health.test.ts
git commit -m "feat(document-opener): http server with /health endpoint"
```

---

## Task 6: CORS handling

**Files:**
- Modify: `scripts/document-opener/src/server.ts`
- Create: `scripts/document-opener/tests/server-cors.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/document-opener/tests/server-cors.test.ts`:

```typescript
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RunningServer } from "../src/server";

const VALID_CONFIG = {
  port: 0,
  roots: ["/Users/foo"],
  allowedOrigins: ["http://localhost:3100", "https://company.whitestag.ai"],
};

describe("server CORS", () => {
  let running: RunningServer;

  afterEach(async () => {
    await running?.close();
  });

  async function start() {
    running = await createServer({ config: VALID_CONFIG, port: 0 });
    const addr = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  it("OPTIONS preflight from allowed origin returns 204 with ACAO", async () => {
    const base = await start();
    const res = await fetch(`${base}/open`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://localhost:3100",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3100");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");
  });

  it("OPTIONS preflight from disallowed origin returns 403 without ACAO", async () => {
    const base = await start();
    const res = await fetch(`${base}/open`, {
      method: "OPTIONS",
      headers: {
        "Origin": "http://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("regular GET /health from allowed origin sets ACAO", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`, {
      headers: { "Origin": "https://company.whitestag.ai" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://company.whitestag.ai");
  });

  it("GET /health without Origin works (e.g. installer health-check)", async () => {
    const base = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: FAIL — preflight returns 404, no CORS headers.

- [ ] **Step 3: Add CORS to server**

Replace contents of `scripts/document-opener/src/server.ts`:

```typescript
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HelperConfig } from "./config.js";

export interface RunningServer {
  server: Server;
  close: () => Promise<void>;
}

export interface CreateServerOptions {
  config: HelperConfig | null;
  port: number;
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // server-to-server, allow
  if (!allowedOrigins.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

function handlePreflight(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigins.includes(origin)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "origin not allowed" }));
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
  res.writeHead(204);
  res.end();
}

function handleHealth(config: HelperConfig | null, res: ServerResponse) {
  res.setHeader("Content-Type", "application/json");
  if (!config) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: "not configured" }));
    return;
  }
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true,
    version: "1",
    roots: config.roots,
  }));
}

export async function createServer(options: CreateServerOptions): Promise<RunningServer> {
  const { config, port } = options;
  const allowedOrigins = config?.allowedOrigins ?? [];

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "OPTIONS") {
      handlePreflight(req, res, allowedOrigins);
      return;
    }

    // Apply CORS headers for non-preflight cross-origin responses
    if (!applyCorsHeaders(req, res, allowedOrigins)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "origin not allowed" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      handleHealth(config, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: All 4 server-health + 4 server-cors tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/document-opener/src/server.ts scripts/document-opener/tests/server-cors.test.ts
git commit -m "feat(document-opener): strict CORS with origin allowlist + preflight"
```

---

## Task 7: /open and /reveal endpoints

**Files:**
- Modify: `scripts/document-opener/src/server.ts`
- Create: `scripts/document-opener/src/handlers.ts`
- Create: `scripts/document-opener/tests/server-open-reveal.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/document-opener/tests/server-open-reveal.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type RunningServer } from "../src/server";

const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    mockExecFile(cmd, args, opts);
    cb(null, "", "");
  },
}));

describe("server /open and /reveal", () => {
  let running: RunningServer;
  let allowedRoot: string;
  let filePath: string;

  beforeEach(() => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "doc-opener-srv-"));
    allowedRoot = join(tmpRoot, "allowed");
    mkdirSync(allowedRoot);
    filePath = join(allowedRoot, "doc.md");
    writeFileSync(filePath, "hello");
    mockExecFile.mockClear();
  });

  afterEach(async () => {
    await running?.close();
  });

  async function start() {
    running = await createServer({
      config: {
        port: 0,
        roots: [allowedRoot],
        allowedOrigins: ["http://localhost:3100"],
      },
      port: 0,
    });
    const addr = running.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  async function post(base: string, route: string, body: unknown) {
    return fetch(`${base}${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "http://localhost:3100",
      },
      body: JSON.stringify(body),
    });
  }

  it("POST /open with valid path returns 200 and calls execFile", async () => {
    const base = await start();
    const res = await post(base, "/open", { path: filePath });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecFile.mock.calls[0]!;
    expect(cmd).toMatch(/^(open|cmd)$/); // darwin or win32 (CI may be either)
    expect(args).toContain(filePath);
  });

  it("POST /reveal with valid path returns 200 and calls execFile", async () => {
    const base = await start();
    const res = await post(base, "/reveal", { path: filePath });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("POST /open with non-existent path returns 404", async () => {
    const base = await start();
    const res = await post(base, "/open", { path: join(allowedRoot, "nope.md") });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not found/i) });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("POST /open with path outside roots returns 403", async () => {
    const base = await start();
    const res = await post(base, "/open", { path: "/etc/hosts" });
    expect(res.status).toBe(403);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("POST /open with empty body returns 400", async () => {
    const base = await start();
    const res = await fetch(`${base}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": "http://localhost:3100" },
      body: "",
    });
    expect(res.status).toBe(400);
  });

  it("POST /open with missing path field returns 400", async () => {
    const base = await start();
    const res = await post(base, "/open", { foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("POST /open when config is null returns 503", async () => {
    running = await createServer({ config: null, port: 0 });
    const addr = running.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${addr.port}`;
    const res = await post(base, "/open", { path: filePath });
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: FAIL — `/open` returns 404 (not yet routed).

- [ ] **Step 3: Implement handlers**

Create `scripts/document-opener/src/handlers.ts`:

```typescript
import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import type { HelperConfig } from "./config.js";
import { openArgs, revealArgs, type CommandSpec } from "./platform.js";
import { ValidationError, validatePath } from "./validate-path.js";

const execFileAsync = promisify(execFile);

const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  OUTSIDE_ROOTS: 403,
  BAD_PATH: 400,
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

export async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  config: HelperConfig | null,
  action: "open" | "reveal",
) {
  if (!config) {
    sendJson(res, 503, { error: "not configured" });
    return;
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    sendJson(res, 400, { error: "invalid json" });
    return;
  }

  if (
    body === null ||
    typeof body !== "object" ||
    typeof (body as { path?: unknown }).path !== "string"
  ) {
    sendJson(res, 400, { error: "missing path field" });
    return;
  }

  const rawPath = (body as { path: string }).path;

  let resolvedPath: string;
  try {
    resolvedPath = validatePath(rawPath, config.roots);
  } catch (err) {
    if (err instanceof ValidationError) {
      sendJson(res, STATUS_BY_CODE[err.code] ?? 400, { error: err.message });
      return;
    }
    sendJson(res, 500, { error: "validation failed" });
    return;
  }

  let spec: CommandSpec;
  try {
    spec = action === "open" ? openArgs(resolvedPath) : revealArgs(resolvedPath);
  } catch (err) {
    sendJson(res, 501, { error: (err as Error).message });
    return;
  }

  try {
    await execFileAsync(spec.cmd, spec.args, { timeout: 5000 });
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string; killed?: boolean };
    if (e.killed) {
      sendJson(res, 504, { error: "timeout" });
      return;
    }
    sendJson(res, 502, { error: `open failed: ${e.stderr || e.message || "unknown"}` });
    return;
  }

  sendJson(res, 200, { ok: true });
}
```

- [ ] **Step 4: Wire `/open` and `/reveal` into server**

Modify `scripts/document-opener/src/server.ts` — replace the route-handling block inside `createHttpServer`'s callback (after the CORS check):

Find this section:

```typescript
    if (req.method === "GET" && req.url === "/health") {
      handleHealth(config, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
```

Replace with:

```typescript
    if (req.method === "GET" && req.url === "/health") {
      handleHealth(config, res);
      return;
    }
    if (req.method === "POST" && req.url === "/open") {
      void handleAction(req, res, config, "open");
      return;
    }
    if (req.method === "POST" && req.url === "/reveal") {
      void handleAction(req, res, config, "reveal");
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
```

And add the import at the top of `server.ts`:

```typescript
import { handleAction } from "./handlers.js";
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `pnpm --filter @paperclipai/document-opener test`
Expected: All previous tests + 7 server-open-reveal tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/document-opener/src/handlers.ts scripts/document-opener/src/server.ts scripts/document-opener/tests/server-open-reveal.test.ts
git commit -m "feat(document-opener): /open and /reveal endpoints"
```

---

## Task 8: Server bootstrap entry-point

**Files:**
- Create: `scripts/document-opener/src/main.ts`

- [ ] **Step 1: Implement bootstrap**

Create `scripts/document-opener/src/main.ts`:

```typescript
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main() {
  const configPath = join(homedir(), ".paperclip", "document-opener.json");
  const config = loadConfig(configPath);

  if (!config) {
    console.error(`[document-opener] config missing or invalid at ${configPath}; server will reject all requests with 503`);
  }

  const port = config?.port ?? 19327;
  const running = await createServer({ config, port });
  console.log(`[document-opener] listening on 127.0.0.1:${port} (roots: ${config?.roots.join(", ") ?? "<none>"})`);

  const shutdown = async (signal: string) => {
    console.log(`[document-opener] received ${signal}, shutting down`);
    await running.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[document-opener] fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Add `main` field to package.json**

Modify `scripts/document-opener/package.json` — change the `build` script and add an `exports`/`main` entry:

```json
{
  "name": "@paperclipai/document-opener",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "build": "esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/main.js",
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "install:agent": "node install.js"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.27.3",
    "tsx": "^4.0.0",
    "typescript": "^5.5.0",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 3: Smoke-test the build**

Run: `pnpm install`
Then: `pnpm --filter @paperclipai/document-opener build`
Then: `ls scripts/document-opener/dist/`
Expected: `main.js` present.

- [ ] **Step 4: Smoke-test running the server**

Run: `node scripts/document-opener/dist/main.js &`
Then: `sleep 1 && curl -s http://127.0.0.1:19327/health`
Expected: `{"error":"not configured"}` (because config file doesn't exist yet).
Then: `kill %1`

- [ ] **Step 5: Commit**

```bash
git add scripts/document-opener/src/main.ts scripts/document-opener/package.json pnpm-lock.yaml
git commit -m "feat(document-opener): main entry-point with config bootstrap"
```

---

## Task 9: launchd plist template (macOS)

**Files:**
- Create: `scripts/document-opener/templates/ing.paperclip.document-opener.plist.template`

- [ ] **Step 1: Create plist template with substitution placeholders**

Create `scripts/document-opener/templates/ing.paperclip.document-opener.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ing.paperclip.document-opener</string>

    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_BIN}}</string>
        <string>{{SCRIPT}}</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>PATH</key>
        <string>{{PATH}}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>{{LOGS}}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>{{LOGS}}/stderr.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
```

- [ ] **Step 2: Commit**

```bash
git add scripts/document-opener/templates/ing.paperclip.document-opener.plist.template
git commit -m "feat(document-opener): launchd plist template for macOS"
```

---

## Task 10: Task Scheduler XML template (Windows)

**Files:**
- Create: `scripts/document-opener/templates/document-opener-task.xml.template`

- [ ] **Step 1: Create task.xml template**

Create `scripts/document-opener/templates/document-opener-task.xml.template`:

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Paperclip Document Opener — local HTTP helper for opening files referenced in Paperclip markdown.</Description>
    <URI>\Paperclip\DocumentOpener</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{{USER}}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{{USER}}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{{NODE_BIN}}</Command>
      <Arguments>"{{SCRIPT}}"</Arguments>
      <WorkingDirectory>{{WORKDIR}}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
```

- [ ] **Step 2: Commit**

```bash
git add scripts/document-opener/templates/document-opener-task.xml.template
git commit -m "feat(document-opener): Task Scheduler XML template for Windows"
```

---

## Task 11: Installer

**Files:**
- Create: `scripts/document-opener/install.js`

- [ ] **Step 1: Implement install.js**

Create `scripts/document-opener/install.js`:

```javascript
#!/usr/bin/env node
// Cross-platform installer for the Paperclip Document-Opener helper.
// macOS: writes a launchd .plist and bootstraps it.
// Windows: writes a Task Scheduler .xml and registers it via schtasks.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DIST_SCRIPT = join(SCRIPT_DIR, "dist", "main.js");
const CONFIG_DIR = join(homedir(), ".paperclip");
const CONFIG_PATH = join(CONFIG_DIR, "document-opener.json");
const NODE_BIN = process.execPath;

function log(msg) { console.log(`[install] ${msg}`); }
function die(msg) { console.error(`[install] ${msg}`); process.exit(1); }

function ensureDefaultConfig() {
  if (existsSync(CONFIG_PATH)) {
    log(`config exists at ${CONFIG_PATH} — leaving untouched`);
    return;
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const defaultConfig = {
    port: 19327,
    roots: [
      join(homedir(), "Documents"),
    ],
    allowedOrigins: [
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "https://company.whitestag.ai",
    ],
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n");
  log(`wrote default config to ${CONFIG_PATH} — edit "roots" to suit your setup`);
}

function build() {
  log("building dist/main.js …");
  const result = spawnSync("pnpm", ["--filter", "@paperclipai/document-opener", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) die("build failed");
  if (!existsSync(DIST_SCRIPT)) die(`build produced no ${DIST_SCRIPT}`);
}

function substitute(template, vars) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

async function healthCheck(port) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 503) {
        log(`health-check OK (status ${res.status}) at ${url}`);
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  die(`health-check timeout: ${url} did not respond within 10s`);
}

function installMacOs() {
  const PLIST_LABEL = "ing.paperclip.document-opener";
  const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
  const PLIST_PATH = join(PLIST_DIR, `${PLIST_LABEL}.plist`);
  const LOGS_DIR = join(homedir(), "Library", "Logs", "paperclip-document-opener");
  const TEMPLATE = readFileSync(join(SCRIPT_DIR, "templates", `${PLIST_LABEL}.plist.template`), "utf8");

  mkdirSync(PLIST_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  const filled = substitute(TEMPLATE, {
    NODE_BIN,
    SCRIPT: DIST_SCRIPT,
    HOME: homedir(),
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LOGS: LOGS_DIR,
  });

  writeFileSync(PLIST_PATH, filled);
  log(`wrote plist to ${PLIST_PATH}`);

  const uid = userInfo().uid;
  log(`bootstrapping launchd as gui/${uid} …`);
  // Best-effort unload first (idempotent re-run)
  spawnSync("launchctl", ["bootout", `gui/${uid}`, PLIST_PATH], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST_PATH], { stdio: "inherit" });
  if (result.status !== 0) die("launchctl bootstrap failed");
}

function installWindows() {
  const TASK_NAME = "\\Paperclip\\DocumentOpener";
  const LOGS_DIR = join(process.env.LOCALAPPDATA || homedir(), "Paperclip", "document-opener", "logs");
  const TASK_XML_PATH = join(tmpdir(), "paperclip-document-opener-task.xml");
  const TEMPLATE = readFileSync(join(SCRIPT_DIR, "templates", "document-opener-task.xml.template"), "utf8");

  mkdirSync(LOGS_DIR, { recursive: true });

  const user = `${process.env.USERDOMAIN || ""}\\${userInfo().username}`.replace(/^\\/, "");
  const filled = substitute(TEMPLATE, {
    NODE_BIN,
    SCRIPT: DIST_SCRIPT,
    WORKDIR: SCRIPT_DIR,
    USER: user,
  });

  // schtasks expects UTF-16 LE for /xml input
  const utf16 = Buffer.from("﻿" + filled, "utf16le");
  writeFileSync(TASK_XML_PATH, utf16);
  log(`wrote task xml to ${TASK_XML_PATH}`);

  log(`registering task ${TASK_NAME} …`);
  const createResult = spawnSync("schtasks", ["/create", "/xml", TASK_XML_PATH, "/tn", TASK_NAME, "/f"], { stdio: "inherit" });
  if (createResult.status !== 0) die("schtasks /create failed");

  log("starting task …");
  const runResult = spawnSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "inherit" });
  if (runResult.status !== 0) die("schtasks /run failed");
}

async function main() {
  log(`platform: ${platform()}`);
  log(`node:     ${NODE_BIN}`);

  ensureDefaultConfig();
  build();

  switch (platform()) {
    case "darwin": installMacOs(); break;
    case "win32":  installWindows(); break;
    default: die(`unsupported platform: ${platform()}`);
  }

  // Read port from config to know where to health-check
  let port = 19327;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof cfg.port === "number") port = cfg.port;
  } catch {}

  await healthCheck(port);
  log("install complete.");
}

main().catch((err) => die(err.message));
```

- [ ] **Step 2: Smoke-test the installer (macOS only — Windows test left to manual run)**

Run: `node scripts/document-opener/install.js`
Expected output ends with `[install] install complete.`
Verify: `launchctl list | grep paperclip.document-opener` shows the label.
Verify: `curl -s http://127.0.0.1:19327/health` returns either `{"error":"not configured"}` (if default `roots` is empty) or a 200 with roots.

- [ ] **Step 3: Edit the default config to point at a real folder**

Open `~/.paperclip/document-opener.json` and replace the `roots` array with:

```json
"roots": [
  "/Users/walterschoenenbroecher.de/SynologyDrive/2026",
  "/Volumes/WHITESTAG-ARCHIV/Obsidian"
]
```

Then restart the helper: `launchctl kickstart -k gui/$(id -u)/ing.paperclip.document-opener`

Verify: `curl -s http://127.0.0.1:19327/health` now returns `{"ok":true,"version":"1","roots":[...]}`.

- [ ] **Step 4: Commit**

```bash
git add scripts/document-opener/install.js
git commit -m "feat(document-opener): cross-platform installer (launchd + Task Scheduler)"
```

---

## Task 12: UI — path detection helpers

**Files:**
- Create: `ui/src/lib/local-document.ts`
- Create: `ui/src/lib/local-document.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/local-document.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { isLocalFileHref, normalizeLocalPath } from "./local-document";

describe("isLocalFileHref", () => {
  it.each([
    ["/Users/foo/x.md", true],
    ["/Volumes/Disk/x.md", true],
    ["~/x.md", true],
    ["file:///Users/foo/x.md", true],
    ["file:///C:/foo/x.md", true],
    ["C:\\Users\\Foo\\x.md", true],
    ["C:/Users/Foo/x.md", true],
    ["D:\\foo.md", true],
    ["\\\\server\\share\\x.md", true],
  ])("recognizes %s as local", (href, expected) => {
    expect(isLocalFileHref(href)).toBe(expected);
  });

  it.each([
    ["http://example.com/x.md", false],
    ["https://example.com/x.md", false],
    ["mailto:foo@bar.com", false],
    ["pcfile://abc", false],
    ["/issues/PCL-123", false],
    ["./relative.md", false],
    ["../up.md", false],
    ["", false],
  ])("does NOT recognize %s as local", (href, expected) => {
    expect(isLocalFileHref(href)).toBe(expected);
  });
});

describe("normalizeLocalPath", () => {
  it("strips file:/// prefix for POSIX paths", () => {
    expect(normalizeLocalPath("file:///Users/foo/x.md")).toBe("/Users/foo/x.md");
  });

  it("strips file:/// prefix and leading / for Windows paths", () => {
    expect(normalizeLocalPath("file:///C:/foo/x.md")).toBe("C:/foo/x.md");
  });

  it("decodes URL-encoded chars", () => {
    expect(normalizeLocalPath("/Users/foo%20bar/x.md")).toBe("/Users/foo bar/x.md");
    expect(normalizeLocalPath("file:///Users/foo%20bar/x.md")).toBe("/Users/foo bar/x.md");
  });

  it("leaves tilde paths unchanged (server expands)", () => {
    expect(normalizeLocalPath("~/x.md")).toBe("~/x.md");
  });

  it("leaves backslash paths unchanged", () => {
    expect(normalizeLocalPath("C:\\foo\\x.md")).toBe("C:\\foo\\x.md");
  });

  it("gracefully passes through invalid URL-encoded sequences", () => {
    expect(normalizeLocalPath("/Users/foo%ZZ.md")).toBe("/Users/foo%ZZ.md");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/local-document.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement local-document.ts**

Create `ui/src/lib/local-document.ts`:

```typescript
const LOCAL_PATH_PATTERNS = [
  /^\/Users\//,                  // macOS user home
  /^\/Volumes\//,                // macOS mounted volumes
  /^~\//,                        // tilde (any OS)
  /^file:\/\/\//,                // file:// URLs (all platforms)
  /^[a-zA-Z]:[\\/]/,             // Windows drive letter: C:\ or C:/
  /^\\\\[^\\]/,                  // Windows UNC: \\server\share
];

export function isLocalFileHref(href: string): boolean {
  if (!href) return false;
  return LOCAL_PATH_PATTERNS.some((re) => re.test(href));
}

export function normalizeLocalPath(href: string): string {
  let value = href;

  if (value.startsWith("file:///")) {
    value = value.slice("file:///".length);
    // For Windows drive-letter forms, the result is "C:/foo/x.md"
    // For POSIX, prepend the slash we just stripped
    if (!/^[a-zA-Z]:/.test(value)) {
      value = "/" + value;
    }
  } else if (value.startsWith("file://")) {
    value = value.slice("file://".length);
  }

  try {
    value = decodeURIComponent(value);
  } catch {
    // leave as-is on malformed percent-encoding
  }

  return value;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/local-document.test.ts`
Expected: All 17 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/local-document.ts ui/src/lib/local-document.test.ts
git commit -m "feat(ui): local-document path detection + normalization"
```

---

## Task 13: UI — fetch helpers for /open and /reveal

**Files:**
- Modify: `ui/src/lib/local-document.ts`
- Modify: `ui/src/lib/local-document.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/lib/local-document.test.ts`:

```typescript
import { afterEach, beforeEach, vi } from "vitest";
import {
  documentOpenerHealth,
  openDocument,
  revealDocument,
  DOCUMENT_OPENER_BASE_URL,
} from "./local-document";

describe("fetch helpers", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("openDocument POSTs to /open with normalized path", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await openDocument("file:///Users/foo/x.md");
    expect(fetchMock).toHaveBeenCalledWith(
      `${DOCUMENT_OPENER_BASE_URL}/open`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/Users/foo/x.md" }),
      }),
    );
  });

  it("revealDocument POSTs to /reveal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await revealDocument("/Users/foo/x.md");
    expect(fetchMock).toHaveBeenCalledWith(
      `${DOCUMENT_OPENER_BASE_URL}/reveal`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "/Users/foo/x.md" }),
      }),
    );
  });

  it("openDocument throws on non-2xx with parsed error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "path outside allowed roots" }), { status: 403 }),
    );
    await expect(openDocument("/etc/hosts")).rejects.toThrow(/path outside allowed roots/);
  });

  it("openDocument throws on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(openDocument("/Users/foo/x.md")).rejects.toThrow();
  });

  it("documentOpenerHealth returns 'ready' on 200", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await documentOpenerHealth();
    expect(result).toBe("ready");
  });

  it("documentOpenerHealth returns 'unavailable' on 503", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    const result = await documentOpenerHealth();
    expect(result).toBe("unavailable");
  });

  it("documentOpenerHealth returns 'unavailable' on network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const result = await documentOpenerHealth();
    expect(result).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/local-document.test.ts`
Expected: FAIL — `openDocument` etc. not exported.

- [ ] **Step 3: Implement fetch helpers**

Append to `ui/src/lib/local-document.ts`:

```typescript
export const DOCUMENT_OPENER_BASE_URL = "http://127.0.0.1:19327";

export type DocumentOpenerStatus = "ready" | "unavailable";

async function callOpener(route: "open" | "reveal", path: string): Promise<void> {
  const normalized = normalizeLocalPath(path);
  let res: Response;
  try {
    res = await fetch(`${DOCUMENT_OPENER_BASE_URL}/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: normalized }),
    });
  } catch (err) {
    throw new Error(
      `Document-Opener nicht erreichbar (${(err as Error).message}). Läuft der Helper-Service?`,
    );
  }
  if (!res.ok) {
    let errorMsg = `${route} failed (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) errorMsg = body.error;
    } catch {
      // body wasn't JSON; keep the generic message
    }
    throw new Error(errorMsg);
  }
}

export function openDocument(path: string): Promise<void> {
  return callOpener("open", path);
}

export function revealDocument(path: string): Promise<void> {
  return callOpener("reveal", path);
}

export async function documentOpenerHealth(): Promise<DocumentOpenerStatus> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DOCUMENT_OPENER_BASE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.status === 200 ? "ready" : "unavailable";
  } catch {
    return "unavailable";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/lib/local-document.test.ts`
Expected: All previous + 7 new fetch tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/local-document.ts ui/src/lib/local-document.test.ts
git commit -m "feat(ui): document-opener fetch helpers + health check"
```

---

## Task 14: UI — DocumentOpenerProvider + useDocumentOpenerStatus hook

**Files:**
- Create: `ui/src/context/DocumentOpenerContext.tsx`
- Create: `ui/src/context/DocumentOpenerContext.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/context/DocumentOpenerContext.test.tsx`:

```typescript
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DocumentOpenerProvider,
  useDocumentOpenerStatus,
} from "./DocumentOpenerContext";

function StatusProbe() {
  const status = useDocumentOpenerStatus();
  return <div data-testid="status">{status}</div>;
}

describe("DocumentOpenerProvider", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts in 'unavailable' before first health response", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    render(
      <DocumentOpenerProvider>
        <StatusProbe />
      </DocumentOpenerProvider>,
    );
    expect(screen.getByTestId("status").textContent).toBe("unavailable");
  });

  it("becomes 'ready' after first 200 from /health", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(
      <DocumentOpenerProvider>
        <StatusProbe />
      </DocumentOpenerProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("status").textContent).toBe("ready");
  });

  it("flips back to 'unavailable' if health starts failing", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    render(
      <DocumentOpenerProvider>
        <StatusProbe />
      </DocumentOpenerProvider>,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("status").textContent).toBe("ready");

    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByTestId("status").textContent).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/context/DocumentOpenerContext.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DocumentOpenerContext**

Create `ui/src/context/DocumentOpenerContext.tsx`:

```typescript
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { documentOpenerHealth, type DocumentOpenerStatus } from "../lib/local-document";

const POLL_INTERVAL_MS = 30_000;

const DocumentOpenerStatusContext = createContext<DocumentOpenerStatus>("unavailable");

export function DocumentOpenerProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DocumentOpenerStatus>("unavailable");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function check() {
      const next = await documentOpenerHealth();
      if (mountedRef.current) setStatus(next);
    }

    void check();
    const handle = window.setInterval(() => void check(), POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      window.clearInterval(handle);
    };
  }, []);

  return (
    <DocumentOpenerStatusContext.Provider value={status}>
      {children}
    </DocumentOpenerStatusContext.Provider>
  );
}

export function useDocumentOpenerStatus(): DocumentOpenerStatus {
  return useContext(DocumentOpenerStatusContext);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/context/DocumentOpenerContext.test.tsx`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/context/DocumentOpenerContext.tsx ui/src/context/DocumentOpenerContext.test.tsx
git commit -m "feat(ui): DocumentOpenerProvider with 30s health polling"
```

---

## Task 15: UI — LocalDocumentLink component

**Files:**
- Create: `ui/src/components/LocalDocumentLink.tsx`
- Create: `ui/src/components/LocalDocumentLink.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/LocalDocumentLink.test.tsx`:

```typescript
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOpenerProvider } from "../context/DocumentOpenerContext";
import { LocalDocumentLink } from "./LocalDocumentLink";

const toastMock = { pushToast: vi.fn() };
vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => toastMock,
}));

describe("LocalDocumentLink", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    toastMock.pushToast.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWithProvider(href: string) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    return render(
      <DocumentOpenerProvider>
        <LocalDocumentLink href={href}>Tagesplan</LocalDocumentLink>
      </DocumentOpenerProvider>,
    );
  }

  it("renders link text and two icon buttons", () => {
    renderWithProvider("/Users/foo/Tagesplan.md");
    expect(screen.getByText("Tagesplan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /öffnen/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finder|explorer/i })).toBeInTheDocument();
  });

  it("clicking 'Öffnen' calls /open with the path", async () => {
    renderWithProvider("/Users/foo/Tagesplan.md");
    await waitFor(() => expect(screen.getByRole("button", { name: /öffnen/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /öffnen/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:19327/open",
        expect.objectContaining({
          body: JSON.stringify({ path: "/Users/foo/Tagesplan.md" }),
        }),
      );
    });
  });

  it("clicking 'Im Finder zeigen' calls /reveal with the path", async () => {
    renderWithProvider("/Users/foo/Tagesplan.md");
    await waitFor(() => expect(screen.getByRole("button", { name: /finder|explorer/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /finder|explorer/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://127.0.0.1:19327/reveal",
        expect.any(Object),
      );
    });
  });

  it("shows error toast on /open failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // health
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "path outside allowed roots" }), { status: 403 }),
    );
    render(
      <DocumentOpenerProvider>
        <LocalDocumentLink href="/etc/hosts">hosts</LocalDocumentLink>
      </DocumentOpenerProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /öffnen/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /öffnen/i }));
    await waitFor(() => {
      expect(toastMock.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "error",
          message: expect.stringContaining("path outside allowed roots"),
        }),
      );
    });
  });

  it("buttons are disabled when status is 'unavailable'", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 503 }));
    render(
      <DocumentOpenerProvider>
        <LocalDocumentLink href="/Users/foo/x.md">x</LocalDocumentLink>
      </DocumentOpenerProvider>,
    );
    // health hasn't returned 200, so should stay disabled
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /öffnen/i })).toBeDisabled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/LocalDocumentLink.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement LocalDocumentLink**

Create `ui/src/components/LocalDocumentLink.tsx`:

```typescript
import { FolderOpen, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { useDocumentOpenerStatus } from "../context/DocumentOpenerContext";
import { openDocument, revealDocument } from "../lib/local-document";
import { useOptionalToastActions } from "../context/ToastContext";

interface LocalDocumentLinkProps {
  href: string;
  children: ReactNode;
}

function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Win/.test(navigator.platform);
}

export function LocalDocumentLink({ href, children }: LocalDocumentLinkProps) {
  const status = useDocumentOpenerStatus();
  const toast = useOptionalToastActions();
  const disabled = status !== "ready";
  const revealLabel = isWindowsPlatform() ? "Im Explorer zeigen" : "Im Finder zeigen";

  const showError = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : "Aktion fehlgeschlagen";
    toast?.pushToast({ tone: "error", message });
  }, [toast]);

  const handleOpen = useCallback(async () => {
    try {
      await openDocument(href);
    } catch (err) {
      showError(err);
    }
  }, [href, showError]);

  const handleReveal = useCallback(async () => {
    try {
      await revealDocument(href);
    } catch (err) {
      showError(err);
    }
  }, [href, showError]);

  return (
    <span className="paperclip-local-document">
      <span>{children}</span>
      <button
        type="button"
        aria-label="Öffnen"
        title={disabled ? "Document-Opener nicht aktiv" : "Öffnen"}
        disabled={disabled}
        onClick={handleOpen}
        className={cn(
          "ml-1 inline-flex h-4 w-4 items-center justify-center align-[-0.125em]",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <SquareArrowOutUpRight aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={revealLabel}
        title={disabled ? "Document-Opener nicht aktiv" : revealLabel}
        disabled={disabled}
        onClick={handleReveal}
        className={cn(
          "ml-1 inline-flex h-4 w-4 items-center justify-center align-[-0.125em]",
          disabled && "opacity-40 cursor-not-allowed",
        )}
      >
        <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/LocalDocumentLink.test.tsx`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/LocalDocumentLink.tsx ui/src/components/LocalDocumentLink.test.tsx
git commit -m "feat(ui): LocalDocumentLink with two inline action buttons"
```

---

## Task 16: MarkdownBody integration

**Files:**
- Modify: `ui/src/components/MarkdownBody.tsx`
- Modify: `ui/src/components/MarkdownBody.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `ui/src/components/MarkdownBody.test.tsx`:

```typescript
import { DocumentOpenerProvider } from "../context/DocumentOpenerContext";

describe("MarkdownBody local-document links", () => {
  it("renders a local POSIX path link with Öffnen + Finder buttons", () => {
    // health stub so provider can transition (not required for this assertion)
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 503 }),
    );
    render(
      <DocumentOpenerProvider>
        <MarkdownBody>{"[Tagesplan](/Users/foo/Tagesplan.md)"}</MarkdownBody>
      </DocumentOpenerProvider>,
    );
    expect(screen.getByText("Tagesplan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /öffnen/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /finder|explorer/i })).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("renders a Windows drive-letter path link with both buttons", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 503 }),
    );
    render(
      <DocumentOpenerProvider>
        <MarkdownBody>{"[Datei](C:/Users/Walter/x.md)"}</MarkdownBody>
      </DocumentOpenerProvider>,
    );
    expect(screen.getByText("Datei")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /öffnen/i })).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it("does NOT add buttons for http links", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 503 }),
    );
    render(
      <DocumentOpenerProvider>
        <MarkdownBody>{"[Beispiel](https://example.com)"}</MarkdownBody>
      </DocumentOpenerProvider>,
    );
    expect(screen.queryByRole("button", { name: /öffnen/i })).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });
});
```

If the test file does not already import `DocumentOpenerProvider`, `render`, `screen`, `vi` — add those imports at the top (they may already be present from other tests; check and add only missing ones).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/MarkdownBody.test.tsx`
Expected: FAIL on the new tests — buttons not rendered (only the plain `<a>` is).

- [ ] **Step 3: Wire `isLocalFileHref` into MarkdownBody**

Modify `ui/src/components/MarkdownBody.tsx`:

**Edit 1** — Add imports near the top (with the other imports):

```typescript
import { isLocalFileHref } from "../lib/local-document";
import { LocalDocumentLink } from "./LocalDocumentLink";
```

**Edit 2** — Update `safeMarkdownUrlTransform` so local paths survive the default URL-transform sanitizer:

Find the existing function (around line 128):

```typescript
function safeMarkdownUrlTransform(url: string): string {
  return parseMentionChipHref(url) ? url : defaultUrlTransform(url);
}
```

Replace with:

```typescript
function safeMarkdownUrlTransform(url: string): string {
  if (parseMentionChipHref(url)) return url;
  if (isLocalFileHref(url)) return url;
  return defaultUrlTransform(url);
}
```

**Edit 3** — Insert a new branch into the `a`-renderer.

Find the existing block (around line 583) where mention-chip handling ends and the GitHub/External default-link rendering begins:

```typescript
      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        // … mention-chip rendering …
      }
      const isGitHubLink = isGitHubUrl(href);
```

Insert a new check BETWEEN the `parsed` block and the `isGitHubLink` line:

```typescript
      const parsed = href ? parseMentionChipHref(href) : null;
      if (parsed) {
        // … (existing mention-chip rendering — leave unchanged) …
      }

      if (href && isLocalFileHref(href)) {
        return <LocalDocumentLink href={href}>{linkChildren}</LocalDocumentLink>;
      }

      const isGitHubLink = isGitHubUrl(href);
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm --filter @paperclipai/ui exec vitest run src/components/MarkdownBody.test.tsx`
Expected: All existing MarkdownBody tests + 3 new local-document tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/MarkdownBody.tsx ui/src/components/MarkdownBody.test.tsx
git commit -m "feat(ui): wire local-document links into MarkdownBody"
```

---

## Task 17: Mount DocumentOpenerProvider in app shell

**Files:**
- Modify: `ui/src/main.tsx`

- [ ] **Step 1: Add provider import**

Open `ui/src/main.tsx` and add this import near the existing context imports:

```typescript
import { DocumentOpenerProvider } from "./context/DocumentOpenerContext";
```

- [ ] **Step 2: Wrap inside ToastProvider**

Find the `<ToastProvider>` block (around line 52). Wrap its children with `<DocumentOpenerProvider>` — DocumentOpenerProvider depends on toast for error messages so toast must be outside:

Find:

```tsx
<ToastProvider>
  {/* … existing children … */}
</ToastProvider>
```

Modify to:

```tsx
<ToastProvider>
  <DocumentOpenerProvider>
    {/* … existing children … */}
  </DocumentOpenerProvider>
</ToastProvider>
```

- [ ] **Step 3: Run UI tests + typecheck**

Run: `pnpm --filter @paperclipai/ui run typecheck`
Expected: No errors.

Run: `pnpm --filter @paperclipai/ui exec vitest run`
Expected: All UI tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.tsx
git commit -m "feat(ui): mount DocumentOpenerProvider in app shell"
```

---

## Task 18: README for scripts/document-opener

**Files:**
- Create: `scripts/document-opener/README.md`

- [ ] **Step 1: Write the README**

Create `scripts/document-opener/README.md`:

```markdown
# @paperclipai/document-opener

Local HTTP helper that lets the Paperclip web UI open or reveal files on the
user's machine. Solves the browser-security restriction that forbids `file://`
links from web pages.

## What it does

Runs as an auto-started background service on `127.0.0.1:19327`. The Paperclip
UI detects absolute file paths in Markdown links and renders two icon buttons
next to each one:

- **Öffnen** → POST `/open` → `open <path>` (macOS) or `cmd /c start "" <path>` (Windows)
- **Im Finder zeigen** / **Im Explorer zeigen** → POST `/reveal` → `open -R <path>` (macOS) or `explorer.exe /select,<path>` (Windows)

## Install

```bash
pnpm --filter @paperclipai/document-opener run install:agent
```

This builds `dist/main.js`, writes a default config to
`~/.paperclip/document-opener.json`, installs the platform-specific auto-start
mechanism (launchd plist or Task Scheduler task), and runs a health-check.

**After install, edit `~/.paperclip/document-opener.json`** — the `roots` array
must list the directories the helper is allowed to open. Example:

```json
{
  "port": 19327,
  "roots": [
    "/Users/walter/SynologyDrive/2026",
    "/Volumes/Archive/Obsidian"
  ],
  "allowedOrigins": [
    "http://localhost:3100",
    "http://127.0.0.1:3100",
    "https://company.whitestag.ai"
  ]
}
```

Restart the helper after editing the config:

- **macOS:** `launchctl kickstart -k gui/$(id -u)/ing.paperclip.document-opener`
- **Windows:** `schtasks /end /tn \Paperclip\DocumentOpener && schtasks /run /tn \Paperclip\DocumentOpener`

## Security model

- Helper binds to `127.0.0.1` only — never reachable from the network
- CORS is strict: only the three configured `allowedOrigins` get an `Access-Control-Allow-Origin` header back
- `Content-Type: application/json` requirement forces a CORS preflight, so a malicious page cannot fire-and-forget a POST
- Paths are validated against `roots`: `realpathSync` resolves symlinks, then a prefix check ensures the real path lies inside an allowed root
- Whitelist comparison is case-insensitive on Windows, case-sensitive on macOS

## Logs

- **macOS:** `~/Library/Logs/paperclip-document-opener/{stdout,stderr}.log`
- **Windows:** `%LOCALAPPDATA%\Paperclip\document-opener\logs\` (helper writes; Task Scheduler does not capture stdout)

## Uninstall

- **macOS:**
  ```bash
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ing.paperclip.document-opener.plist
  rm ~/Library/LaunchAgents/ing.paperclip.document-opener.plist
  ```
- **Windows:**
  ```cmd
  schtasks /delete /tn \Paperclip\DocumentOpener /f
  ```

## Troubleshooting

- **UI buttons grayed out** → helper is unreachable. Check `curl http://127.0.0.1:19327/health` and the log files.
- **`403 path outside allowed roots`** → add the directory to `roots` in the config and restart the helper.
- **`502 open failed`** → the OS-level `open` command failed; check the helper logs for stderr.
```

- [ ] **Step 2: Commit**

```bash
git add scripts/document-opener/README.md
git commit -m "docs(document-opener): installation + troubleshooting README"
```

---

## Task 19: End-to-end smoke test (manual)

**Files:** (none — verification only)

- [ ] **Step 1: Run the install**

```bash
pnpm --filter @paperclipai/document-opener run install:agent
```

Expected: ends with `[install] install complete.` and no error output.

- [ ] **Step 2: Edit config to a real folder**

Edit `~/.paperclip/document-opener.json` and set `roots` to include the current repo's `docs/` directory:

```json
"roots": [
  "/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip/docs"
]
```

Then: `launchctl kickstart -k gui/$(id -u)/ing.paperclip.document-opener`

- [ ] **Step 3: Verify /health**

Run: `curl -s http://127.0.0.1:19327/health | jq`
Expected:
```json
{
  "ok": true,
  "version": "1",
  "roots": ["/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip/docs"]
}
```

- [ ] **Step 4: Verify /open**

Run:
```bash
curl -s -X POST http://127.0.0.1:19327/open \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3100" \
  -d '{"path":"/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip/docs/superpowers/specs/2026-05-13-document-opener-design.md"}'
```

Expected:
- Response: `{"ok":true}`
- The spec file opens in your default markdown viewer

- [ ] **Step 5: Verify /reveal**

```bash
curl -s -X POST http://127.0.0.1:19327/reveal \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3100" \
  -d '{"path":"/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip/docs/superpowers/specs/2026-05-13-document-opener-design.md"}'
```

Expected:
- Response: `{"ok":true}`
- Finder opens with the spec file selected

- [ ] **Step 6: Verify CORS allowlist**

```bash
curl -s -i -X OPTIONS http://127.0.0.1:19327/open \
  -H "Origin: http://evil.example.com" \
  -H "Access-Control-Request-Method: POST"
```

Expected: HTTP 403, no `Access-Control-Allow-Origin` header.

- [ ] **Step 7: Verify whitelist enforcement**

```bash
curl -s -X POST http://127.0.0.1:19327/open \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3100" \
  -d '{"path":"/etc/hosts"}'
```

Expected: `{"error":"path outside allowed roots: /etc/hosts"}` with HTTP 403.

- [ ] **Step 8: Verify UI**

Start Paperclip dev server (the existing `pnpm dev` chain — should already be running via `ing.paperclip.dev`).

In the browser, open any issue, edit its description, paste a Markdown link:

```markdown
[Spec](/Users/walterschoenenbroecher.de/SynologyDrive/2026/AI/Claude Code/Paperclip/docs/superpowers/specs/2026-05-13-document-opener-design.md)
```

Save. Expected:
- The link "Spec" renders with two small icon buttons next to it
- Clicking the "Öffnen" icon opens the spec in your default Markdown viewer
- Clicking the "Im Finder zeigen" icon opens Finder with the spec selected

- [ ] **Step 9: No commit needed — this task is verification only.**

---

## Spec Coverage Check

| Spec section / requirement                                | Implemented in       |
|-----------------------------------------------------------|----------------------|
| Helper on `127.0.0.1:19327`                               | Tasks 5, 8           |
| `/health`, `/open`, `/reveal` endpoints                   | Tasks 5, 7           |
| Tilde + Windows env expansion                             | Task 2               |
| Realpath/symlink-escape protection                        | Task 2               |
| Whitelist root check (case-aware)                         | Task 2               |
| `execFile` 5s timeout                                     | Task 7               |
| CORS allowlist + preflight                                | Task 6               |
| Platform dispatch (open/reveal commands)                  | Task 4               |
| launchd auto-start (macOS)                                | Tasks 9, 11          |
| Task Scheduler auto-start (Windows)                       | Tasks 10, 11         |
| Cross-platform Node installer                             | Task 11              |
| `process.execPath` for Node binary location               | Task 11              |
| Default config + manual edit step                         | Tasks 11, 18         |
| `isLocalFileHref` + `normalizeLocalPath`                  | Task 12              |
| `openDocument` / `revealDocument` fetch helpers           | Task 13              |
| `useDocumentOpenerStatus` health-polling hook             | Task 14              |
| `LocalDocumentLink` component (two icons, disabled state) | Task 15              |
| MarkdownBody integration                                  | Task 16              |
| `safeMarkdownUrlTransform` bypass for local paths         | Task 16, Edit 2      |
| Provider mounted in app shell                             | Task 17              |
| Error toasts via ToastContext                             | Tasks 13, 15         |
| README + troubleshooting                                  | Task 18              |
| End-to-end smoke test                                     | Task 19              |
