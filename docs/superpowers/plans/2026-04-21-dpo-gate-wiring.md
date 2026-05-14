# DPO-Gate Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productively wire `paperclip-dpo` as a LAN-reachable HTTP service, route all n8n→OpenAI traffic through a DPO-Proxy sub-workflow, provide a TS client for future direct-API callers, document policy, and add Telegram-alert monitoring.

**Architecture:** New `paperclip-dpo-service` package runs Fastify on `0.0.0.0:4711` on the Mac Studio, depends on existing `paperclip-dpo` library via `file:` link. Shared-secret (`X-DPO-Key`) auth for LAN access. Monitor is an in-process tail loop that fires direct Telegram alerts for Art-9 blocks, classifier-down, and elevated error rates. n8n integrates through a single sub-workflow `DPO-Proxy V1` that is called from parent workflows.

**Tech Stack:** TypeScript, Node 20+, Fastify 4, Zod, Vitest, pnpm, better-sqlite3 (inherited from paperclip-dpo), keytar (inherited), launchd.

**Reference spec:** [`docs/superpowers/specs/2026-04-21-dpo-gate-wiring-design.md`](../specs/2026-04-21-dpo-gate-wiring-design.md)

---

## File Structure

### New package: `paperclip-dpo-service/`

| File | Responsibility |
|---|---|
| `package.json` | Declare deps (fastify, zod, paperclip-dpo via file:), scripts |
| `tsconfig.json` | Extends `tsconfig.base.json` |
| `vitest.config.ts` | Test config |
| `README.md` | Install/run docs, env vars |
| `src/config.ts` | Zod schema, env → `ServiceConfig` |
| `src/auth.ts` | `X-DPO-Key` preHandler using `timingSafeEqual` |
| `src/server.ts` | Fastify app factory — takes `Dpo` + config, registers routes, no listen |
| `src/routes/health.ts` | `GET /health` — classifier ping, 10s cache |
| `src/routes/anonymize.ts` | `POST /anonymize` |
| `src/routes/deanonymize.ts` | `POST /deanonymize` |
| `src/routes/safe-call.ts` | `POST /safe-call` — orchestrates anonymize → external → deanonymize |
| `src/template.ts` | Render `bodyTemplate` (`{{prompt}}`) + `responsePath` extractor |
| `src/telegram.ts` | `postTelegram()` — thin HTTPS POST wrapper |
| `src/audit-tail.ts` | Stream new lines from today's JSONL file |
| `src/monitor.ts` | Trigger evaluation + 10-min dedup, calls `postTelegram` |
| `src/index.ts` | Entry point — loads config, creates Dpo, starts server + monitor |
| `tests/auth.test.ts` | Timing-safe compare, 401s |
| `tests/routes/health.test.ts` | Reachable/unreachable classifier |
| `tests/routes/anonymize.test.ts` | Happy, blocked-art9, blocked-unavailable, 400, 401 |
| `tests/routes/deanonymize.test.ts` | Happy, unknown-mappingId → 404 |
| `tests/routes/safe-call.test.ts` | Happy, block-propagation, external-failure |
| `tests/template.test.ts` | Nested `{{prompt}}` replacement, response-path extraction |
| `tests/telegram.test.ts` | POST body shape, error handling |
| `tests/audit-tail.test.ts` | Reads new appended lines, skips already-read |
| `tests/monitor.test.ts` | Trigger fires once, dedup window holds |
| `tests/integration.test.ts` | Opt-in `DPO_INTEGRATION=1` — real Gemma |
| `scripts/generate-shared-key.sh` | Emits random key to stdout |
| `scripts/install-launchd.sh` | Installs plist, starts service |
| `ai.whitestag.paperclip-dpo.plist` | launchd unit template |

### Extend `paperclip-dpo/`

| File | Responsibility |
|---|---|
| `src/client.ts` | `createDpoClient()` — fetch wrapper |
| `src/index.ts` | Re-export client |
| `tests/client.test.ts` | Mocked-fetch unit tests |

### n8n workflows (`projekte/n8n-workflows/`)

| File | Responsibility |
|---|---|
| `DPO-Proxy V1.json` | Sub-workflow: anonymize → OpenAI → deanonymize |
| `Luna Voice + Telegram V11.json` | V10 migrated to call DPO-Proxy V1 |
| `Paperclip CEO - Voice & Telegram V4.json` | V3 migrated to call DPO-Proxy V1 |

### Policy doc

| File | Responsibility |
|---|---|
| `projekte/dpo/DPO-Policy.md` | Coverage table, trusted-local LLMs, review cadence |

---

## Phase 1 — Service Scaffolding

### Task 1: Create `paperclip-dpo-service` package skeleton

**Files:**
- Create: `paperclip-dpo-service/package.json`
- Create: `paperclip-dpo-service/tsconfig.json`
- Create: `paperclip-dpo-service/vitest.config.ts`
- Create: `paperclip-dpo-service/.gitignore`
- Create: `paperclip-dpo-service/src/index.ts` (stub)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "paperclip-dpo-service",
  "version": "0.1.0",
  "description": "HTTP-Service for paperclip-dpo — LAN-reachable anonymisation gate",
  "type": "module",
  "private": true,
  "main": "./dist/index.js",
  "bin": {
    "paperclip-dpo-service": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "zod": "^3.23.0",
    "paperclip-dpo": "file:../paperclip-dpo"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: Create stub src/index.ts**

```ts
console.log("paperclip-dpo-service boot stub");
```

- [ ] **Step 6: Build paperclip-dpo first, then install service**

Run:
```bash
cd paperclip-dpo && pnpm install && pnpm build
cd ../paperclip-dpo-service && pnpm install
```

Expected: both complete without errors. `paperclip-dpo/dist/index.js` must exist.

- [ ] **Step 7: Verify build**

Run: `cd paperclip-dpo-service && pnpm build`
Expected: `dist/index.js` produced.

- [ ] **Step 8: Commit**

```bash
git add paperclip-dpo-service/
git commit -m "chore(dpo-service): scaffold package"
```

---

### Task 2: Config loader

**Files:**
- Create: `paperclip-dpo-service/src/config.ts`
- Create: `paperclip-dpo-service/tests/config.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads env vars with defaults", () => {
    const cfg = loadConfig({
      DPO_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
    });
    expect(cfg.port).toBe(4711);
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.sharedKey).toBe("secret-key-32-bytes-min-length-padding-more");
    expect(cfg.classifier.url).toBe("http://localhost:1234");
    expect(cfg.classifier.model).toBe("gemma-4-26b");
    expect(cfg.classifier.timeoutMs).toBe(30000);
    expect(cfg.telegram).toBeUndefined();
  });

  it("includes telegram when both env vars set", () => {
    const cfg = loadConfig({
      DPO_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
      DPO_TELEGRAM_BOT_TOKEN: "bot-token",
      DPO_TELEGRAM_CHAT_ID: "12345",
    });
    expect(cfg.telegram).toEqual({ botToken: "bot-token", chatId: "12345" });
  });

  it("rejects short shared key", () => {
    expect(() => loadConfig({
      DPO_SHARED_KEY: "short",
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
    })).toThrow(/DPO_SHARED_KEY/);
  });

  it("rejects missing shared key", () => {
    expect(() => loadConfig({
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/config.test.ts`
Expected: FAIL — `loadConfig` not defined.

- [ ] **Step 3: Implement src/config.ts**

```ts
import { z } from "zod";

const Schema = z.object({
  DPO_PORT: z.coerce.number().default(4711),
  DPO_BIND: z.string().default("0.0.0.0"),
  DPO_SHARED_KEY: z.string().min(32, "DPO_SHARED_KEY must be at least 32 chars"),
  DPO_MAPPING_DB: z.string(),
  DPO_MAPPING_KEY_REF: z.string().default("keychain:ai.whitestag.paperclip-dpo.mapping"),
  DPO_AUDIT_DIR: z.string(),
  DPO_CLASSIFIER_URL: z.string().default("http://localhost:1234"),
  DPO_CLASSIFIER_MODEL: z.string().default("gemma-4-26b"),
  DPO_CLASSIFIER_TIMEOUT_MS: z.coerce.number().default(30000),
  DPO_TELEGRAM_BOT_TOKEN: z.string().optional(),
  DPO_TELEGRAM_CHAT_ID: z.string().optional(),
});

export interface ServiceConfig {
  port: number;
  bind: string;
  sharedKey: string;
  mappingDbPath: string;
  mappingKeyRef: string;
  auditDir: string;
  classifier: { url: string; model: string; timeoutMs: number };
  telegram?: { botToken: string; chatId: string };
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): ServiceConfig {
  const parsed = Schema.parse(env);
  const telegram = parsed.DPO_TELEGRAM_BOT_TOKEN && parsed.DPO_TELEGRAM_CHAT_ID
    ? { botToken: parsed.DPO_TELEGRAM_BOT_TOKEN, chatId: parsed.DPO_TELEGRAM_CHAT_ID }
    : undefined;
  return {
    port: parsed.DPO_PORT,
    bind: parsed.DPO_BIND,
    sharedKey: parsed.DPO_SHARED_KEY,
    mappingDbPath: parsed.DPO_MAPPING_DB,
    mappingKeyRef: parsed.DPO_MAPPING_KEY_REF,
    auditDir: parsed.DPO_AUDIT_DIR,
    classifier: {
      url: parsed.DPO_CLASSIFIER_URL,
      model: parsed.DPO_CLASSIFIER_MODEL,
      timeoutMs: parsed.DPO_CLASSIFIER_TIMEOUT_MS,
    },
    telegram,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/config.ts paperclip-dpo-service/tests/config.test.ts
git commit -m "feat(dpo-service): config loader with zod schema"
```

---

### Task 3: Auth middleware

**Files:**
- Create: `paperclip-dpo-service/src/auth.ts`
- Create: `paperclip-dpo-service/tests/auth.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../src/auth.js";

describe("auth", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify();
    registerAuth(app, { sharedKey: "correct-secret-32-bytes-xxxxxxxxxxx" });
    app.get("/protected", async () => ({ ok: true }));
    app.get("/health", { config: { noAuth: true } }, async () => ({ ok: true }));
    await app.ready();
  });

  it("401 when header missing", async () => {
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("401 when header wrong", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-dpo-key": "wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("200 when header correct", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-dpo-key": "correct-secret-32-bytes-xxxxxxxxxxx" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("bypasses auth for routes marked noAuth", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/auth.test.ts`
Expected: FAIL — `registerAuth` not defined.

- [ ] **Step 3: Implement src/auth.ts**

```ts
import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";

declare module "fastify" {
  interface FastifyContextConfig {
    noAuth?: boolean;
  }
}

export interface AuthOptions {
  sharedKey: string;
}

export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  const expected = Buffer.from(opts.sharedKey, "utf8");

  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions?.config?.noAuth) return;
    const provided = req.headers["x-dpo-key"];
    if (typeof provided !== "string") {
      reply.code(401).send({ error: "missing X-DPO-Key" });
      return reply;
    }
    const given = Buffer.from(provided, "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      reply.code(401).send({ error: "invalid X-DPO-Key" });
      return reply;
    }
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/auth.ts paperclip-dpo-service/tests/auth.test.ts
git commit -m "feat(dpo-service): timing-safe X-DPO-Key auth middleware"
```

---

## Phase 2 — DPO Routes

### Task 4: `/health` route

**Files:**
- Create: `paperclip-dpo-service/src/routes/health.ts`
- Create: `paperclip-dpo-service/tests/routes/health.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/routes/health.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoute } from "../../src/routes/health.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.useFakeTimers();
    app = Fastify();
  });

  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });

  it("reports classifier reachable on 200 ping", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", classifier: "reachable" });
  });

  it("reports classifier unreachable on fetch failure", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", classifier: "unreachable" });
  });

  it("caches result for 10s", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    registerHealthRoute(app, { classifierUrl: "http://x:1234", fetchFn });
    await app.ready();
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/health" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11000);
    await app.inject({ method: "GET", url: "/health" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/health.test.ts`
Expected: FAIL — `registerHealthRoute` not found.

- [ ] **Step 3: Implement src/routes/health.ts**

```ts
import type { FastifyInstance } from "fastify";

export interface HealthOptions {
  classifierUrl: string;
  fetchFn?: typeof fetch;
  pingTimeoutMs?: number;
}

const CACHE_MS = 10_000;

export function registerHealthRoute(app: FastifyInstance, opts: HealthOptions): void {
  const f = opts.fetchFn ?? fetch;
  const timeout = opts.pingTimeoutMs ?? 3_000;
  let cachedAt = 0;
  let cached: "reachable" | "unreachable" = "unreachable";

  async function probe(): Promise<"reachable" | "unreachable"> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await f(`${opts.classifierUrl}/v1/models`, { signal: ctrl.signal });
      return res.ok ? "reachable" : "unreachable";
    } catch {
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  }

  app.get("/health", { config: { noAuth: true } }, async () => {
    const now = Date.now();
    if (now - cachedAt > CACHE_MS) {
      cached = await probe();
      cachedAt = now;
    }
    return { status: "ok", classifier: cached };
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/health.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/routes/health.ts paperclip-dpo-service/tests/routes/health.test.ts
git commit -m "feat(dpo-service): /health route with 10s cache"
```

---

### Task 5: `/anonymize` route

**Files:**
- Create: `paperclip-dpo-service/src/routes/anonymize.ts`
- Create: `paperclip-dpo-service/tests/routes/anonymize.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/routes/anonymize.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerAnonymizeRoute } from "../../src/routes/anonymize.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function makeApp(dpo: Dpo): FastifyInstance {
  const app = Fastify();
  registerAuth(app, { sharedKey: KEY });
  registerAnonymizeRoute(app, { dpo });
  return app;
}

describe("POST /anonymize", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("returns pseudonymised text on success", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m-1",
        anonymizedText: "Hi [PERSON_A]",
        findings: [{ type: "PERSON", count: 1, confidence: "high" }],
        warnings: [],
      }),
      deanonymize: vi.fn(),
      close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "Hi Max", targetLlm: "gpt-4o", agent: "luna" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      blocked: false,
      anonymizedText: "Hi [PERSON_A]",
      mappingId: "m-1",
    });
    expect(dpo.anonymize).toHaveBeenCalledWith({
      text: "Hi Max", targetLlm: "gpt-4o", agent: "luna", tenantId: undefined,
    });
  });

  it("propagates art_9 block", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "art_9_data_detected" }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x", targetLlm: "gpt-4o", agent: "luna" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: true, reason: "art_9_data_detected" });
  });

  it("propagates dpo_unavailable block", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "dpo_unavailable" }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x", targetLlm: "gpt-4o", agent: "luna" },
    });
    expect(res.json()).toEqual({ blocked: true, reason: "dpo_unavailable" });
  });

  it("400 on missing required field", async () => {
    const dpo = { anonymize: vi.fn(), deanonymize: vi.fn(), close: vi.fn() };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("401 when key missing", async () => {
    const dpo = { anonymize: vi.fn(), deanonymize: vi.fn(), close: vi.fn() };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "content-type": "application/json" },
      payload: { text: "x", targetLlm: "g", agent: "l" },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/anonymize.test.ts`
Expected: FAIL — `registerAnonymizeRoute` not defined.

- [ ] **Step 3: Implement src/routes/anonymize.ts**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";

const Body = z.object({
  text: z.string().min(1),
  targetLlm: z.string().min(1),
  agent: z.string().min(1),
  tenantId: z.string().optional(),
});

export interface AnonymizeRouteOptions {
  dpo: Dpo;
}

export function registerAnonymizeRoute(app: FastifyInstance, opts: AnonymizeRouteOptions): void {
  app.post("/anonymize", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }
    const result = await opts.dpo.anonymize(parsed.data);
    if ("blocked" in result && result.blocked) {
      return { blocked: true, reason: result.reason };
    }
    return {
      blocked: false,
      anonymizedText: result.anonymizedText,
      mappingId: result.mappingId,
    };
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/anonymize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/routes/anonymize.ts paperclip-dpo-service/tests/routes/anonymize.test.ts
git commit -m "feat(dpo-service): POST /anonymize route"
```

---

### Task 6: `/deanonymize` route

**Files:**
- Create: `paperclip-dpo-service/src/routes/deanonymize.ts`
- Create: `paperclip-dpo-service/tests/routes/deanonymize.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/routes/deanonymize.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerDeanonymizeRoute } from "../../src/routes/deanonymize.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function makeApp(dpo: Dpo): FastifyInstance {
  const app = Fastify();
  registerAuth(app, { sharedKey: KEY });
  registerDeanonymizeRoute(app, { dpo });
  return app;
}

describe("POST /deanonymize", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("returns deanonymised text", async () => {
    const dpo = {
      anonymize: vi.fn(),
      deanonymize: vi.fn().mockReturnValue({ text: "Hi Max" }),
      close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/deanonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { mappingId: "m-1", text: "Hi [PERSON_A]" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "Hi Max" });
    expect(dpo.deanonymize).toHaveBeenCalledWith({ mappingId: "m-1", text: "Hi [PERSON_A]" });
  });

  it("404 when mappingId unknown", async () => {
    const dpo = {
      anonymize: vi.fn(),
      deanonymize: vi.fn().mockImplementation(() => {
        throw new Error("mapping not found: m-x");
      }),
      close: vi.fn(),
    };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/deanonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { mappingId: "m-x", text: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 on bad body", async () => {
    const dpo = { anonymize: vi.fn(), deanonymize: vi.fn(), close: vi.fn() };
    app = makeApp(dpo as unknown as Dpo);
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/deanonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { mappingId: "m-1" },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/deanonymize.test.ts`
Expected: FAIL — `registerDeanonymizeRoute` not defined.

- [ ] **Step 3: Implement src/routes/deanonymize.ts**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";

const Body = z.object({
  mappingId: z.string().min(1),
  text: z.string(),
});

export interface DeanonymizeRouteOptions {
  dpo: Dpo;
}

export function registerDeanonymizeRoute(app: FastifyInstance, opts: DeanonymizeRouteOptions): void {
  app.post("/deanonymize", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }
    try {
      const result = opts.dpo.deanonymize(parsed.data);
      return { text: result.text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("mapping not found") || msg.includes("not found")) {
        return reply.code(404).send({ error: "mapping_not_found" });
      }
      throw err;
    }
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/deanonymize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/routes/deanonymize.ts paperclip-dpo-service/tests/routes/deanonymize.test.ts
git commit -m "feat(dpo-service): POST /deanonymize route"
```

---

### Task 7: Template helper (bodyTemplate + responsePath)

**Files:**
- Create: `paperclip-dpo-service/src/template.ts`
- Create: `paperclip-dpo-service/tests/template.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderBodyTemplate, extractByPath } from "../src/template.js";

describe("renderBodyTemplate", () => {
  it("replaces {{prompt}} in nested strings", () => {
    const tpl = { model: "gpt", messages: [{ role: "user", content: "say: {{prompt}}" }] };
    const out = renderBodyTemplate(tpl, { prompt: "hello" });
    expect(out).toEqual({ model: "gpt", messages: [{ role: "user", content: "say: hello" }] });
  });

  it("leaves non-string values untouched", () => {
    const tpl = { temperature: 0.5, streaming: false, n: null };
    const out = renderBodyTemplate(tpl, { prompt: "x" });
    expect(out).toEqual({ temperature: 0.5, streaming: false, n: null });
  });

  it("replaces multiple occurrences", () => {
    const out = renderBodyTemplate({ a: "{{prompt}}-{{prompt}}" }, { prompt: "y" });
    expect(out).toEqual({ a: "y-y" });
  });
});

describe("extractByPath", () => {
  it("extracts dot-path value", () => {
    const obj = { choices: [{ message: { content: "hi" } }] };
    expect(extractByPath(obj, "choices.0.message.content")).toBe("hi");
  });

  it("returns undefined on missing path", () => {
    expect(extractByPath({}, "a.b.c")).toBeUndefined();
  });

  it("throws when extracted value is not a string", () => {
    expect(() => extractByPath({ a: 1 }, "a")).toThrow(/not a string/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/template.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/template.ts**

```ts
export function renderBodyTemplate<T>(template: T, vars: { prompt: string }): T {
  if (typeof template === "string") {
    return template.replaceAll("{{prompt}}", vars.prompt) as unknown as T;
  }
  if (Array.isArray(template)) {
    return template.map((v) => renderBodyTemplate(v, vars)) as unknown as T;
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      out[k] = renderBodyTemplate(v, vars);
    }
    return out as unknown as T;
  }
  return template;
}

export function extractByPath(obj: unknown, path: string): string | undefined {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  if (cur === undefined) return undefined;
  if (typeof cur !== "string") {
    throw new Error(`value at path "${path}" is not a string`);
  }
  return cur;
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/template.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/template.ts paperclip-dpo-service/tests/template.test.ts
git commit -m "feat(dpo-service): bodyTemplate renderer and responsePath extractor"
```

---

### Task 8: `/safe-call` route

**Files:**
- Create: `paperclip-dpo-service/src/routes/safe-call.ts`
- Create: `paperclip-dpo-service/tests/routes/safe-call.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/routes/safe-call.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "../../src/auth.js";
import { registerSafeCallRoute } from "../../src/routes/safe-call.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

function baseExternal() {
  return {
    url: "https://api.openai.com/v1/chat/completions",
    method: "POST" as const,
    headers: { Authorization: "Bearer t" },
    bodyTemplate: { model: "gpt", messages: [{ role: "user", content: "{{prompt}}" }] },
    responsePath: "choices.0.message.content",
  };
}

describe("POST /safe-call", () => {
  let app: FastifyInstance;
  afterEach(async () => app && (await app.close()));

  it("runs full roundtrip", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m-1", anonymizedText: "Hi [PERSON_A]",
        findings: [], warnings: [],
      }),
      deanonymize: vi.fn().mockReturnValue({ text: "Hi Max back" }),
      close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "Hi [PERSON_A] back" } }] }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();

    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: {
        prompt: "Hi Max", targetLlm: "gpt", agent: "luna",
        external: baseExternal(),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ blocked: false, text: "Hi Max back" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt", messages: [{ role: "user", content: "Hi [PERSON_A]" }],
    });
  });

  it("propagates anonymize block without calling external", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({ blocked: true, reason: "art_9_data_detected" }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    const fetchFn = vi.fn();
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.json()).toEqual({ blocked: true, reason: "art_9_data_detected" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("502 when external returns non-2xx", async () => {
    const dpo = {
      anonymize: vi.fn().mockResolvedValue({
        mappingId: "m", anonymizedText: "x", findings: [], warnings: [],
      }),
      deanonymize: vi.fn(), close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response("oops", { status: 500 }));
    app = Fastify();
    registerAuth(app, { sharedKey: KEY });
    registerSafeCallRoute(app, { dpo: dpo as unknown as Dpo, fetchFn });
    await app.ready();
    const res = await app.inject({
      method: "POST", url: "/safe-call",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { prompt: "x", targetLlm: "g", agent: "l", external: baseExternal() },
    });
    expect(res.statusCode).toBe(502);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/safe-call.test.ts`
Expected: FAIL — `registerSafeCallRoute` not defined.

- [ ] **Step 3: Implement src/routes/safe-call.ts**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";
import { renderBodyTemplate, extractByPath } from "../template.js";

const Body = z.object({
  prompt: z.string().min(1),
  targetLlm: z.string().min(1),
  agent: z.string().min(1),
  tenantId: z.string().optional(),
  external: z.object({
    url: z.string().url(),
    method: z.enum(["POST", "PUT"]).default("POST"),
    headers: z.record(z.string()).default({}),
    bodyTemplate: z.record(z.any()),
    responsePath: z.string().min(1),
  }),
});

export interface SafeCallRouteOptions {
  dpo: Dpo;
  fetchFn?: typeof fetch;
}

export function registerSafeCallRoute(app: FastifyInstance, opts: SafeCallRouteOptions): void {
  const f = opts.fetchFn ?? fetch;

  app.post("/safe-call", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }
    const { prompt, targetLlm, agent, tenantId, external } = parsed.data;

    const anon = await opts.dpo.anonymize({ text: prompt, targetLlm, agent, tenantId });
    if ("blocked" in anon && anon.blocked) {
      return { blocked: true, reason: anon.reason };
    }

    const body = renderBodyTemplate(external.bodyTemplate, { prompt: anon.anonymizedText });
    const res = await f(external.url, {
      method: external.method,
      headers: { "content-type": "application/json", ...external.headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return reply.code(502).send({ error: "external_failed", status: res.status, body: text });
    }
    const json = await res.json();
    const extracted = extractByPath(json, external.responsePath);
    if (extracted === undefined) {
      return reply.code(502).send({ error: "response_path_missing", path: external.responsePath });
    }
    const deanon = opts.dpo.deanonymize({ mappingId: anon.mappingId, text: extracted });
    return { blocked: false, text: deanon.text };
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/routes/safe-call.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/routes/safe-call.ts paperclip-dpo-service/tests/routes/safe-call.test.ts
git commit -m "feat(dpo-service): POST /safe-call route with template rendering"
```

---

## Phase 3 — Server Bootstrap

### Task 9: Server factory

**Files:**
- Create: `paperclip-dpo-service/src/server.ts`
- Create: `paperclip-dpo-service/tests/server.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/server.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { buildServer } from "../src/server.js";
import type { Dpo } from "paperclip-dpo";

const KEY = "test-key-32-bytes-xxxxxxxxxxxxxxx";

describe("buildServer", () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  afterEach(async () => app && (await app.close()));

  it("wires all routes", async () => {
    const dpo: Dpo = {
      anonymize: vi.fn().mockResolvedValue({ mappingId: "m", anonymizedText: "x", findings: [], warnings: [] }),
      deanonymize: vi.fn().mockReturnValue({ text: "x" }),
      close: vi.fn(),
    };
    const fetchFn = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    app = await buildServer({
      sharedKey: KEY,
      classifierUrl: "http://localhost:1234",
      dpo,
      fetchFn,
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const anon = await app.inject({
      method: "POST", url: "/anonymize",
      headers: { "x-dpo-key": KEY, "content-type": "application/json" },
      payload: { text: "x", targetLlm: "y", agent: "z" },
    });
    expect(anon.statusCode).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/server.test.ts`
Expected: FAIL — `buildServer` not defined.

- [ ] **Step 3: Implement src/server.ts**

```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Dpo } from "paperclip-dpo";
import { registerAuth } from "./auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAnonymizeRoute } from "./routes/anonymize.js";
import { registerDeanonymizeRoute } from "./routes/deanonymize.js";
import { registerSafeCallRoute } from "./routes/safe-call.js";

export interface BuildServerOptions {
  sharedKey: string;
  classifierUrl: string;
  dpo: Dpo;
  fetchFn?: typeof fetch;
  logger?: boolean;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  registerAuth(app, { sharedKey: opts.sharedKey });
  registerHealthRoute(app, { classifierUrl: opts.classifierUrl, fetchFn: opts.fetchFn });
  registerAnonymizeRoute(app, { dpo: opts.dpo });
  registerDeanonymizeRoute(app, { dpo: opts.dpo });
  registerSafeCallRoute(app, { dpo: opts.dpo, fetchFn: opts.fetchFn });
  await app.ready();
  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/server.ts paperclip-dpo-service/tests/server.test.ts
git commit -m "feat(dpo-service): buildServer factory wires all routes"
```

---

## Phase 4 — Monitoring

### Task 10: Audit-log tailer

**Files:**
- Create: `paperclip-dpo-service/src/audit-tail.ts`
- Create: `paperclip-dpo-service/tests/audit-tail.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/audit-tail.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTailer } from "../src/audit-tail.js";

describe("AuditTailer", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dpo-tail-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns new lines on each poll", () => {
    const file = join(dir, "dpo-2026-04-21.jsonl");
    writeFileSync(file, JSON.stringify({ ts: "2026-04-21T10:00:00Z", blocked: false }) + "\n");
    const tailer = new AuditTailer({ dir, day: "2026-04-21" });
    const first = tailer.poll();
    expect(first).toHaveLength(1);
    appendFileSync(file, JSON.stringify({ ts: "2026-04-21T10:05:00Z", blocked: true, blockedReason: "art_9_data_detected" }) + "\n");
    const second = tailer.poll();
    expect(second).toHaveLength(1);
    expect(second[0].blockedReason).toBe("art_9_data_detected");
    const third = tailer.poll();
    expect(third).toHaveLength(0);
  });

  it("returns empty array when file does not exist", () => {
    const tailer = new AuditTailer({ dir, day: "2026-04-21" });
    expect(tailer.poll()).toEqual([]);
  });

  it("skips malformed lines", () => {
    const file = join(dir, "dpo-2026-04-21.jsonl");
    writeFileSync(file, "not-json\n" + JSON.stringify({ ts: "x", blocked: false }) + "\n");
    const tailer = new AuditTailer({ dir, day: "2026-04-21" });
    const entries = tailer.poll();
    expect(entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/audit-tail.test.ts`
Expected: FAIL — `AuditTailer` not defined.

- [ ] **Step 3: Implement src/audit-tail.ts**

```ts
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntryLite {
  ts: string;
  agent?: string;
  targetLlm?: string;
  blocked: boolean;
  blockedReason?: string;
  findings?: Record<string, number>;
}

export interface AuditTailerOptions {
  dir: string;
  day: string;
}

export class AuditTailer {
  private readonly path: string;
  private offset = 0;
  private buffer = "";

  constructor(opts: AuditTailerOptions) {
    this.path = join(opts.dir, `dpo-${opts.day}.jsonl`);
  }

  poll(): AuditEntryLite[] {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size <= this.offset) return [];
    const fd = openSync(this.path, "r");
    try {
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.offset);
      this.offset = size;
      this.buffer += buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const out: AuditEntryLite[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as AuditEntryLite);
      } catch {
        // skip malformed
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/audit-tail.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/audit-tail.ts paperclip-dpo-service/tests/audit-tail.test.ts
git commit -m "feat(dpo-service): JSONL audit-log tailer"
```

---

### Task 11: Telegram alerter

**Files:**
- Create: `paperclip-dpo-service/src/telegram.ts`
- Create: `paperclip-dpo-service/tests/telegram.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/telegram.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { postTelegram } from "../src/telegram.js";

describe("postTelegram", () => {
  it("POSTs to sendMessage with chat_id and text", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await postTelegram({
      botToken: "T", chatId: "42", text: "hello",
    }, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.telegram.org/botT/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ chat_id: "42", text: "hello", parse_mode: "Markdown" });
  });

  it("swallows errors (never throws)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("net"));
    await expect(
      postTelegram({ botToken: "T", chatId: "42", text: "x" }, fetchFn)
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/telegram.test.ts`
Expected: FAIL — `postTelegram` not defined.

- [ ] **Step 3: Implement src/telegram.ts**

```ts
export interface TelegramMessage {
  botToken: string;
  chatId: string;
  text: string;
}

export async function postTelegram(
  msg: TelegramMessage,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchFn(`https://api.telegram.org/bot${msg.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chatId,
        text: msg.text,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // alerts must never crash the service
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/telegram.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/telegram.ts paperclip-dpo-service/tests/telegram.test.ts
git commit -m "feat(dpo-service): telegram alert POST helper"
```

---

### Task 12: Monitor loop (trigger evaluation + dedup)

**Files:**
- Create: `paperclip-dpo-service/src/monitor.ts`
- Create: `paperclip-dpo-service/tests/monitor.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/monitor.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { Monitor } from "../src/monitor.js";
import type { AuditEntryLite } from "../src/audit-tail.js";

function entry(overrides: Partial<AuditEntryLite> = {}): AuditEntryLite {
  return {
    ts: new Date().toISOString(),
    blocked: false,
    ...overrides,
  };
}

describe("Monitor", () => {
  it("fires on art_9 block", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    expect(alert).toHaveBeenCalledTimes(1);
    const [msg] = alert.mock.calls[0]!;
    expect(msg).toMatch(/art_9/i);
  });

  it("dedupes same trigger within window", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("fires again after dedup window expires", () => {
    const alert = vi.fn();
    let t = 1000;
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => t });
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    t += 601_000;
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("fires on 3rd consecutive classifier-unreachable", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("unreachable");
    expect(alert).not.toHaveBeenCalled();
    m.recordClassifierStatus("unreachable");
    expect(alert).toHaveBeenCalledTimes(1);
    const [msg] = alert.mock.calls[0]!;
    expect(msg).toMatch(/classifier/i);
  });

  it("resets classifier counter on reachable", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("reachable");
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("unreachable");
    expect(alert).not.toHaveBeenCalled();
  });

  it("fires when error rate exceeds 10/hour", () => {
    const alert = vi.fn();
    let t = 1000;
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => t });
    // dpo_unavailable counts as an error
    for (let i = 0; i < 11; i++) {
      m.evaluate([entry({ blocked: true, blockedReason: "dpo_unavailable" })]);
      t += 1000;
    }
    expect(alert).toHaveBeenCalled();
    expect(alert.mock.calls.some(([msg]) => /rate/i.test(String(msg)))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/monitor.test.ts`
Expected: FAIL — `Monitor` not defined.

- [ ] **Step 3: Implement src/monitor.ts**

```ts
import type { AuditEntryLite } from "./audit-tail.js";

export type AlertFn = (message: string) => void;
export type ClassifierStatus = "reachable" | "unreachable";

export interface MonitorOptions {
  alertFn: AlertFn;
  dedupMs?: number;
  errorRateThreshold?: number;
  errorRateWindowMs?: number;
  classifierFailThreshold?: number;
  now?: () => number;
}

type TriggerKey = "art_9" | "classifier_down" | "error_rate";

export class Monitor {
  private readonly alertFn: AlertFn;
  private readonly dedupMs: number;
  private readonly errorRateThreshold: number;
  private readonly errorRateWindowMs: number;
  private readonly classifierFailThreshold: number;
  private readonly now: () => number;

  private lastFiredAt: Partial<Record<TriggerKey, number>> = {};
  private errorTimestamps: number[] = [];
  private classifierFailStreak = 0;

  constructor(opts: MonitorOptions) {
    this.alertFn = opts.alertFn;
    this.dedupMs = opts.dedupMs ?? 600_000;
    this.errorRateThreshold = opts.errorRateThreshold ?? 10;
    this.errorRateWindowMs = opts.errorRateWindowMs ?? 3_600_000;
    this.classifierFailThreshold = opts.classifierFailThreshold ?? 3;
    this.now = opts.now ?? Date.now;
  }

  evaluate(entries: AuditEntryLite[]): void {
    for (const e of entries) {
      if (e.blocked && e.blockedReason === "art_9_data_detected") {
        this.tryFire("art_9", `🚨 DPO Art-9 block\nagent: ${e.agent ?? "?"}\ntargetLlm: ${e.targetLlm ?? "?"}\nts: ${e.ts}`);
      }
      if (e.blocked) {
        this.errorTimestamps.push(this.now());
      }
    }
    const cutoff = this.now() - this.errorRateWindowMs;
    this.errorTimestamps = this.errorTimestamps.filter((t) => t >= cutoff);
    if (this.errorTimestamps.length > this.errorRateThreshold) {
      this.tryFire("error_rate", `⚠️ DPO error rate: ${this.errorTimestamps.length} blocks in last hour`);
    }
  }

  recordClassifierStatus(status: ClassifierStatus): void {
    if (status === "reachable") {
      this.classifierFailStreak = 0;
      return;
    }
    this.classifierFailStreak++;
    if (this.classifierFailStreak >= this.classifierFailThreshold) {
      this.tryFire("classifier_down", `🚨 DPO classifier unreachable (${this.classifierFailStreak} consecutive fails)`);
    }
  }

  private tryFire(key: TriggerKey, msg: string): void {
    const last = this.lastFiredAt[key] ?? -Infinity;
    if (this.now() - last < this.dedupMs) return;
    this.lastFiredAt[key] = this.now();
    this.alertFn(msg);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/monitor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/monitor.ts paperclip-dpo-service/tests/monitor.test.ts
git commit -m "feat(dpo-service): monitor with trigger evaluation and 10-min dedup"
```

---

### Task 13: Monitor runner (periodic poll)

**Files:**
- Create: `paperclip-dpo-service/src/monitor-runner.ts`
- Create: `paperclip-dpo-service/tests/monitor-runner.test.ts`

- [ ] **Step 1: Write failing test**

`paperclip-dpo-service/tests/monitor-runner.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { startMonitorRunner } from "../src/monitor-runner.js";

describe("startMonitorRunner", () => {
  it("polls tailer and classifier at interval", async () => {
    vi.useFakeTimers();
    const tailer = { poll: vi.fn().mockReturnValue([]) };
    const classifierProbe = vi.fn().mockResolvedValue("reachable" as const);
    const monitor = { evaluate: vi.fn(), recordClassifierStatus: vi.fn() };
    const stop = startMonitorRunner({
      tailer, classifierProbe, monitor, intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tailer.poll).toHaveBeenCalledTimes(2);
    expect(classifierProbe).toHaveBeenCalledTimes(2);
    expect(monitor.evaluate).toHaveBeenCalledTimes(2);
    expect(monitor.recordClassifierStatus).toHaveBeenCalledWith("reachable");
    stop();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/monitor-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/monitor-runner.ts**

```ts
import type { Monitor, ClassifierStatus } from "./monitor.js";
import type { AuditTailer } from "./audit-tail.js";

export interface MonitorRunnerOptions {
  tailer: Pick<AuditTailer, "poll">;
  classifierProbe: () => Promise<ClassifierStatus>;
  monitor: Pick<Monitor, "evaluate" | "recordClassifierStatus">;
  intervalMs?: number;
}

export function startMonitorRunner(opts: MonitorRunnerOptions): () => void {
  const interval = opts.intervalMs ?? 5 * 60_000;
  const tick = async () => {
    try {
      opts.monitor.evaluate(opts.tailer.poll());
      opts.monitor.recordClassifierStatus(await opts.classifierProbe());
    } catch {
      // never let runner errors kill the service
    }
  };
  const t = setInterval(tick, interval);
  return () => clearInterval(t);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/monitor-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add paperclip-dpo-service/src/monitor-runner.ts paperclip-dpo-service/tests/monitor-runner.test.ts
git commit -m "feat(dpo-service): periodic monitor runner"
```

---

## Phase 5 — Entry Point

### Task 14: `src/index.ts` entry point

**Files:**
- Create: `paperclip-dpo-service/src/classifier-probe.ts`
- Modify: `paperclip-dpo-service/src/index.ts`
- Create: `paperclip-dpo-service/tests/classifier-probe.test.ts`

- [ ] **Step 1: Write failing test for classifier probe**

`paperclip-dpo-service/tests/classifier-probe.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeClassifierProbe } from "../src/classifier-probe.js";

describe("makeClassifierProbe", () => {
  it("returns reachable on 2xx", async () => {
    const probe = makeClassifierProbe({
      url: "http://x", timeoutMs: 1000,
      fetchFn: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });
    await expect(probe()).resolves.toBe("reachable");
  });
  it("returns unreachable on fetch error", async () => {
    const probe = makeClassifierProbe({
      url: "http://x", timeoutMs: 1000,
      fetchFn: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await expect(probe()).resolves.toBe("unreachable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/classifier-probe.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/classifier-probe.ts**

```ts
import type { ClassifierStatus } from "./monitor.js";

export interface ProbeOptions {
  url: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export function makeClassifierProbe(opts: ProbeOptions): () => Promise<ClassifierStatus> {
  const f = opts.fetchFn ?? fetch;
  return async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await f(`${opts.url}/v1/models`, { signal: ctrl.signal });
      return res.ok ? "reachable" : "unreachable";
    } catch {
      return "unreachable";
    } finally {
      clearTimeout(timer);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/classifier-probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement src/index.ts (replaces stub)**

```ts
import { createDpo } from "paperclip-dpo";
import { getOrCreateMappingKey } from "paperclip-dpo/keychain";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { AuditTailer } from "./audit-tail.js";
import { Monitor } from "./monitor.js";
import { startMonitorRunner } from "./monitor-runner.js";
import { makeClassifierProbe } from "./classifier-probe.js";
import { postTelegram } from "./telegram.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const mappingKey = await getOrCreateMappingKey();

  const dpo = createDpo({
    mappingDbPath: cfg.mappingDbPath,
    mappingKey,
    auditDir: cfg.auditDir,
    classifier: cfg.classifier,
  });

  const app = await buildServer({
    sharedKey: cfg.sharedKey,
    classifierUrl: cfg.classifier.url,
    dpo,
    logger: true,
  });

  const alertFn = cfg.telegram
    ? (msg: string) => void postTelegram({
        botToken: cfg.telegram!.botToken,
        chatId: cfg.telegram!.chatId,
        text: msg,
      })
    : (msg: string) => console.error("[ALERT]", msg);

  const monitor = new Monitor({ alertFn });
  const tailer = new AuditTailer({ dir: cfg.auditDir, day: new Date().toISOString().slice(0, 10) });
  const probe = makeClassifierProbe({ url: cfg.classifier.url, timeoutMs: 3000 });
  const stopRunner = startMonitorRunner({ tailer, classifierProbe: probe, monitor });

  const shutdown = async (): Promise<void> => {
    stopRunner();
    await app.close();
    dpo.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: cfg.port, host: cfg.bind });
  console.log(`paperclip-dpo-service listening on ${cfg.bind}:${cfg.port}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
```

- [ ] **Step 6: Expose `paperclip-dpo/keychain` subpath**

The index.ts above imports `paperclip-dpo/keychain`. The existing `paperclip-dpo/package.json` only exports `"."`. Update it.

Modify `paperclip-dpo/package.json` exports field:

```json
"exports": {
  ".": "./dist/index.js",
  "./keychain": "./dist/keychain.js"
},
```

- [ ] **Step 7: Rebuild paperclip-dpo and paperclip-dpo-service**

Run:
```bash
cd paperclip-dpo && pnpm build
cd ../paperclip-dpo-service && pnpm build
```

Expected: both succeed.

- [ ] **Step 8: Commit**

```bash
git add paperclip-dpo-service/src/classifier-probe.ts paperclip-dpo-service/src/index.ts paperclip-dpo-service/tests/classifier-probe.test.ts paperclip-dpo/package.json
git commit -m "feat(dpo-service): entry point wires config, server, monitor"
```

---

### Task 15: Shared-key generation script

**Files:**
- Create: `paperclip-dpo-service/scripts/generate-shared-key.sh`

- [ ] **Step 1: Create script**

```bash
#!/usr/bin/env bash
set -euo pipefail
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

- [ ] **Step 2: Make executable and test**

Run:
```bash
chmod +x paperclip-dpo-service/scripts/generate-shared-key.sh
paperclip-dpo-service/scripts/generate-shared-key.sh
```

Expected: prints a ~43-character base64url string.

- [ ] **Step 3: Commit**

```bash
git add paperclip-dpo-service/scripts/generate-shared-key.sh
git commit -m "chore(dpo-service): shared-key generator script"
```

---

### Task 16: launchd plist + install script

**Files:**
- Create: `paperclip-dpo-service/ai.whitestag.paperclip-dpo.plist`
- Create: `paperclip-dpo-service/scripts/install-launchd.sh`

- [ ] **Step 1: Create plist template**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.whitestag.paperclip-dpo</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE_BIN__</string>
    <string>__INSTALL_DIR__/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>__INSTALL_DIR__</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DPO_SHARED_KEY</key><string>__SHARED_KEY__</string>
    <key>DPO_MAPPING_DB</key><string>/var/paperclip/dpo/mappings.db</string>
    <key>DPO_AUDIT_DIR</key><string>/var/paperclip/dpo/audit</string>
    <key>DPO_CLASSIFIER_URL</key><string>http://localhost:1234</string>
    <key>DPO_CLASSIFIER_MODEL</key><string>gemma-4-26b</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/var/log/paperclip-dpo/out.log</string>
  <key>StandardErrorPath</key><string>/var/log/paperclip-dpo/err.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Create install script**

```bash
#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HOME/Library/LaunchAgents/ai.whitestag.paperclip-dpo.plist"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p /var/paperclip/dpo /var/log/paperclip-dpo 2>/dev/null || {
  echo "Need write access to /var/paperclip and /var/log. Run with sudo once to create these, then chown to your user." >&2
  exit 1
}

if [[ -z "${DPO_SHARED_KEY:-}" ]]; then
  echo "Set DPO_SHARED_KEY before running (generate via ./scripts/generate-shared-key.sh)" >&2
  exit 1
fi

sed \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__INSTALL_DIR__|$SERVICE_DIR|g" \
  -e "s|__SHARED_KEY__|$DPO_SHARED_KEY|g" \
  "$SERVICE_DIR/ai.whitestag.paperclip-dpo.plist" > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load -w "$TARGET"
echo "Installed. Check: curl http://localhost:4711/health"
```

- [ ] **Step 3: Make executable**

Run: `chmod +x paperclip-dpo-service/scripts/install-launchd.sh`

- [ ] **Step 4: Commit**

```bash
git add paperclip-dpo-service/ai.whitestag.paperclip-dpo.plist paperclip-dpo-service/scripts/install-launchd.sh
git commit -m "chore(dpo-service): launchd plist + install script"
```

---

### Task 17: README for the service

**Files:**
- Create: `paperclip-dpo-service/README.md`

- [ ] **Step 1: Write README**

```markdown
# paperclip-dpo-service

Fastify-HTTP-Gate für die `paperclip-dpo`-Library. Läuft auf dem Mac Studio, erreichbar aus `192.168.2.0/24` unter Port 4711.

## Endpoints

| Method | Path | Auth | Zweck |
|---|---|---|---|
| GET | `/health` | — | Classifier-Status (10s cached) |
| POST | `/anonymize` | `X-DPO-Key` | Pseudonymisiert Text |
| POST | `/deanonymize` | `X-DPO-Key` | Stellt Klartext aus Pseudonymen wieder her |
| POST | `/safe-call` | `X-DPO-Key` | Kompletter Roundtrip (anon → extern → deanon) |

## Installation

```bash
# 1. Build
cd paperclip-dpo && pnpm install && pnpm build
cd ../paperclip-dpo-service && pnpm install && pnpm build

# 2. Shared Key generieren und in macOS-Keychain ablegen
SHARED_KEY=$(./scripts/generate-shared-key.sh)
security add-generic-password -s ai.whitestag.paperclip-dpo-key -a shared -w "$SHARED_KEY"

# 3. launchd installieren
sudo mkdir -p /var/paperclip/dpo /var/log/paperclip-dpo
sudo chown $USER /var/paperclip/dpo /var/log/paperclip-dpo
DPO_SHARED_KEY="$SHARED_KEY" ./scripts/install-launchd.sh

# 4. Smoke-Test
curl http://localhost:4711/health
```

## Env Vars

| Var | Default | Pflicht | Beschreibung |
|---|---|---|---|
| `DPO_SHARED_KEY` | — | ja | Shared Secret, min 32 Zeichen |
| `DPO_PORT` | `4711` | | HTTP-Port |
| `DPO_BIND` | `0.0.0.0` | | Listen-Interface |
| `DPO_MAPPING_DB` | — | ja | SQLite-Pfad |
| `DPO_AUDIT_DIR` | — | ja | JSONL-Log-Dir |
| `DPO_CLASSIFIER_URL` | `http://localhost:1234` | | LM Studio Endpoint |
| `DPO_CLASSIFIER_MODEL` | `gemma-4-26b` | | Classifier-Modell |
| `DPO_CLASSIFIER_TIMEOUT_MS` | `30000` | | Classifier-Timeout |
| `DPO_TELEGRAM_BOT_TOKEN` | — | | Alerts aktiv wenn gesetzt |
| `DPO_TELEGRAM_CHAT_ID` | — | | Chat für Alerts |

## Firewall (macOS)

macOS fragt beim ersten Start, ob `node` eingehende Verbindungen akzeptieren darf — zulassen. Oder manuell:
```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$(command -v node)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$(command -v node)"
```

## Klient-Verteilung

Andere Hosts (n8n-Host, Windows-CFO) brauchen den `DPO_SHARED_KEY`-Wert für ihren `X-DPO-Key`-Header. Übertragung via 1Password / Windows-Credential-Store / n8n-Credential.
```

- [ ] **Step 2: Commit**

```bash
git add paperclip-dpo-service/README.md
git commit -m "docs(dpo-service): installation & env-var README"
```

---

## Phase 6 — TS Client in paperclip-dpo

### Task 18: `createDpoClient`

**Files:**
- Create: `paperclip-dpo/src/client.ts`
- Create: `paperclip-dpo/tests/client.test.ts`
- Modify: `paperclip-dpo/src/index.ts:131-133`

- [ ] **Step 1: Write failing test**

`paperclip-dpo/tests/client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createDpoClient } from "../src/client.js";

const KEY = "client-test-key-32-bytes-xxxxxxxxx";

describe("createDpoClient", () => {
  it("anonymize POSTs with X-DPO-Key and returns body", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ blocked: false, anonymizedText: "a", mappingId: "m" }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createDpoClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.anonymize({ text: "t", targetLlm: "l", agent: "a" });
    expect(out).toEqual({ blocked: false, anonymizedText: "a", mappingId: "m" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("http://x:4711/anonymize");
    expect(init.method).toBe("POST");
    expect(init.headers["x-dpo-key"]).toBe(KEY);
  });

  it("deanonymize returns { text }", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "back" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createDpoClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.deanonymize({ mappingId: "m", text: "x" });
    expect(out).toEqual({ text: "back" });
  });

  it("safeCall passes external payload through", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ blocked: false, text: "done" }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createDpoClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.safeCall({
      prompt: "p", targetLlm: "t", agent: "a",
      external: {
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {}, bodyTemplate: { content: "{{prompt}}" },
        responsePath: "content",
      },
    });
    expect(out).toEqual({ blocked: false, text: "done" });
  });

  it("propagates blocked response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ blocked: true, reason: "art_9_data_detected" }),
        { status: 200, headers: { "content-type": "application/json" } })
    );
    const client = createDpoClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    const out = await client.anonymize({ text: "t", targetLlm: "l", agent: "a" });
    expect(out).toEqual({ blocked: true, reason: "art_9_data_detected" });
  });

  it("throws on non-2xx (except blocked-200)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const client = createDpoClient({ baseUrl: "http://x:4711", sharedKey: KEY, fetchFn });
    await expect(client.anonymize({ text: "t", targetLlm: "l", agent: "a" }))
      .rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd paperclip-dpo && pnpm vitest run tests/client.test.ts`
Expected: FAIL — `createDpoClient` not found.

- [ ] **Step 3: Implement src/client.ts**

```ts
export interface DpoClientOptions {
  baseUrl: string;
  sharedKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface ClientAnonymizeInput {
  text: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
}

export type ClientAnonymizeResult =
  | { blocked: false; anonymizedText: string; mappingId: string }
  | { blocked: true; reason: string };

export interface ClientSafeCallInput {
  prompt: string;
  targetLlm: string;
  agent: string;
  tenantId?: string;
  external: {
    url: string;
    method?: "POST" | "PUT";
    headers?: Record<string, string>;
    bodyTemplate: Record<string, unknown>;
    responsePath: string;
  };
}

export type ClientSafeCallResult =
  | { blocked: false; text: string }
  | { blocked: true; reason: string };

export interface DpoClient {
  anonymize(input: ClientAnonymizeInput): Promise<ClientAnonymizeResult>;
  deanonymize(input: { mappingId: string; text: string }): Promise<{ text: string }>;
  safeCall(input: ClientSafeCallInput): Promise<ClientSafeCallResult>;
  health(): Promise<{ status: string; classifier: string }>;
}

export function createDpoClient(opts: DpoClientOptions): DpoClient {
  const f = opts.fetchFn ?? fetch;
  const timeout = opts.timeoutMs ?? 60_000;
  const base = opts.baseUrl.replace(/\/$/, "");

  async function post<T>(path: string, body: unknown, requireAuth = true): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (requireAuth) headers["x-dpo-key"] = opts.sharedKey;
      const res = await f(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`dpo ${path} ${res.status}: ${await res.text().catch(() => "")}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    anonymize: (input) => post<ClientAnonymizeResult>("/anonymize", input),
    deanonymize: (input) => post<{ text: string }>("/deanonymize", input),
    safeCall: (input) => post<ClientSafeCallResult>("/safe-call", input),
    async health() {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await f(`${base}/health`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`health ${res.status}`);
        return (await res.json()) as { status: string; classifier: string };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

- [ ] **Step 4: Add export to paperclip-dpo/src/index.ts**

At end of `paperclip-dpo/src/index.ts`, add after existing exports:

```ts
export { createDpoClient, type DpoClient, type DpoClientOptions } from "./client.js";
```

- [ ] **Step 5: Rebuild and run tests**

Run:
```bash
cd paperclip-dpo && pnpm build && pnpm vitest run tests/client.test.ts
```

Expected: build succeeds, 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add paperclip-dpo/src/client.ts paperclip-dpo/src/index.ts paperclip-dpo/tests/client.test.ts
git commit -m "feat(dpo): add createDpoClient HTTP wrapper"
```

---

## Phase 7 — Service-Level Integration Test

### Task 19: Opt-in integration test

**Files:**
- Create: `paperclip-dpo-service/tests/integration.test.ts`

- [ ] **Step 1: Write test (opt-in via env flag)**

`paperclip-dpo-service/tests/integration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDpo } from "paperclip-dpo";
import { buildServer } from "../src/server.js";

const RUN = process.env.DPO_INTEGRATION === "1";
const SUITE = RUN ? describe : describe.skip;

SUITE("integration (real Gemma via LM Studio)", () => {
  it("anonymises a real prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dpo-int-"));
    try {
      const dpo = createDpo({
        mappingDbPath: join(dir, "m.db"),
        mappingKey: randomBytes(32),
        auditDir: join(dir, "audit"),
        classifier: {
          url: process.env.LM_STUDIO_URL ?? "http://localhost:1234",
          model: process.env.LM_STUDIO_MODEL ?? "gemma-4-26b",
          timeoutMs: 30000,
        },
      });
      try {
        const app = await buildServer({
          sharedKey: "integration-key-32-bytes-padding-xxx",
          classifierUrl: "http://localhost:1234",
          dpo,
        });
        try {
          const res = await app.inject({
            method: "POST",
            url: "/anonymize",
            headers: {
              "x-dpo-key": "integration-key-32-bytes-padding-xxx",
              "content-type": "application/json",
            },
            payload: {
              text: "Max Mustermann von WHITESTAG GmbH (max@whitestag.de) grüßt aus Cottbus.",
              targetLlm: "gpt-4o-mini",
              agent: "integration-test",
            },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.blocked).toBe(false);
          expect(body.anonymizedText).not.toContain("max@whitestag.de");
        } finally {
          await app.close();
        }
      } finally {
        dpo.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run (skipped by default)**

Run: `cd paperclip-dpo-service && pnpm vitest run tests/integration.test.ts`
Expected: PASS (skipped — 0 tests executed).

- [ ] **Step 3: Optional real run**

With LM Studio running with `gemma-4-26b`:
```bash
DPO_INTEGRATION=1 pnpm vitest run tests/integration.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add paperclip-dpo-service/tests/integration.test.ts
git commit -m "test(dpo-service): opt-in integration test"
```

---

## Phase 8 — n8n Integration

### Task 20: `DPO-Proxy V1` sub-workflow

**Files:**
- Create: `projekte/n8n-workflows/DPO-Proxy V1.json`

- [ ] **Step 1: Create sub-workflow JSON**

Note: This JSON is imported into n8n, then **manually activated there**. No automated test.

```json
{
  "name": "DPO-Proxy V1",
  "nodes": [
    {
      "parameters": {
        "inputSource": "passthrough"
      },
      "name": "When Executed by Another Workflow",
      "type": "n8n-nodes-base.executeWorkflowTrigger",
      "position": [260, 300],
      "id": "trigger-1",
      "typeVersion": 1
    },
    {
      "parameters": {
        "method": "POST",
        "url": "=http://192.168.2.10:4711/anonymize",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"text\": \"{{ $json.prompt }}\",\n  \"targetLlm\": \"{{ $json.targetLlm }}\",\n  \"agent\": \"{{ $json.agent }}\"\n}",
        "options": { "timeout": 60000 }
      },
      "name": "Anonymize",
      "type": "n8n-nodes-base.httpRequest",
      "position": [500, 300],
      "id": "anon-1",
      "typeVersion": 4.2,
      "credentials": { "httpHeaderAuth": { "id": "DPO_SHARED_KEY_CRED_ID", "name": "DPO Shared Key" } }
    },
    {
      "parameters": {
        "conditions": {
          "conditions": [
            { "leftValue": "={{ $json.blocked }}", "rightValue": true, "operator": { "type": "boolean", "operation": "true" } }
          ],
          "combinator": "and"
        }
      },
      "name": "Blocked?",
      "type": "n8n-nodes-base.if",
      "position": [740, 300],
      "id": "if-1",
      "typeVersion": 2.1
    },
    {
      "parameters": {
        "method": "POST",
        "url": "=https://api.openai.com/v1/chat/completions",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "openAiApi",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"model\": \"{{ $('When Executed by Another Workflow').item.json.model }}\",\n  \"messages\": [\n    {\"role\": \"user\", \"content\": \"{{ $json.anonymizedText }}\"}\n  ]\n}",
        "options": { "timeout": 120000 }
      },
      "name": "OpenAI Call",
      "type": "n8n-nodes-base.httpRequest",
      "position": [980, 400],
      "id": "openai-1",
      "typeVersion": 4.2,
      "credentials": { "openAiApi": { "id": "OPENAI_CRED_ID", "name": "OpenAI API" } }
    },
    {
      "parameters": {
        "method": "POST",
        "url": "=http://192.168.2.10:4711/deanonymize",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"mappingId\": \"{{ $('Anonymize').item.json.mappingId }}\",\n  \"text\": \"{{ $json.choices[0].message.content }}\"\n}",
        "options": { "timeout": 60000 }
      },
      "name": "Deanonymize",
      "type": "n8n-nodes-base.httpRequest",
      "position": [1220, 400],
      "id": "deanon-1",
      "typeVersion": 4.2,
      "credentials": { "httpHeaderAuth": { "id": "DPO_SHARED_KEY_CRED_ID", "name": "DPO Shared Key" } }
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ blocked: false, text: $input.first().json.text }];"
      },
      "name": "Format Success",
      "type": "n8n-nodes-base.code",
      "position": [1460, 400],
      "id": "fmt-success",
      "typeVersion": 2
    },
    {
      "parameters": {
        "mode": "runOnceForAllItems",
        "jsCode": "return [{ blocked: true, reason: $input.first().json.reason }];"
      },
      "name": "Format Blocked",
      "type": "n8n-nodes-base.code",
      "position": [980, 200],
      "id": "fmt-blocked",
      "typeVersion": 2
    }
  ],
  "connections": {
    "When Executed by Another Workflow": { "main": [[{ "node": "Anonymize", "type": "main", "index": 0 }]] },
    "Anonymize": { "main": [[{ "node": "Blocked?", "type": "main", "index": 0 }]] },
    "Blocked?": {
      "main": [
        [{ "node": "Format Blocked", "type": "main", "index": 0 }],
        [{ "node": "OpenAI Call", "type": "main", "index": 0 }]
      ]
    },
    "OpenAI Call": { "main": [[{ "node": "Deanonymize", "type": "main", "index": 0 }]] },
    "Deanonymize": { "main": [[{ "node": "Format Success", "type": "main", "index": 0 }]] }
  },
  "settings": { "executionOrder": "v1" },
  "pinData": {}
}
```

- [ ] **Step 2: Manual import & credential setup in n8n**

1. Import `DPO-Proxy V1.json` into n8n.
2. Create HTTP Header Auth credential "DPO Shared Key": Header name `X-DPO-Key`, value = shared key.
3. Replace placeholder credential IDs `DPO_SHARED_KEY_CRED_ID` / `OPENAI_CRED_ID` via n8n UI (n8n rewrites them on save).
4. Replace the hardcoded `192.168.2.10` with the actual Mac Studio IP if different.
5. Activate workflow.

- [ ] **Step 3: Smoke test via n8n UI**

From n8n, execute `DPO-Proxy V1` with input:
```json
{
  "prompt": "Hi from Max Mustermann at max@whitestag.de",
  "targetLlm": "gpt-4o-mini",
  "model": "gpt-4o-mini",
  "agent": "smoke-test"
}
```
Expected: success, `text` contains `Max Mustermann` and `max@whitestag.de` (de-anonymised).

- [ ] **Step 4: Commit**

```bash
git add "projekte/n8n-workflows/DPO-Proxy V1.json"
git commit -m "feat(n8n): DPO-Proxy V1 sub-workflow"
```

---

### Task 21: Migrate `Luna Voice + Telegram V10` → `V11`

**Files:**
- Create: `projekte/n8n-workflows/Luna Voice + Telegram V11.json` (copy of V10 with changes)

- [ ] **Step 1: Copy V10 to V11**

Run:
```bash
cp "projekte/n8n-workflows/Luna Voice + Telegram V10.json" "projekte/n8n-workflows/Luna Voice + Telegram V11.json"
```

- [ ] **Step 2: Update `name` field inside V11 JSON**

Edit `projekte/n8n-workflows/Luna Voice + Telegram V11.json` — find the top-level `"name": "Luna Voice + Telegram V10"` and change to `"Luna Voice + Telegram V11"`.

- [ ] **Step 3: Replace OpenAI Chat Model node with Execute Workflow call to DPO-Proxy**

In the V11 JSON, locate the node of type `@n8n/n8n-nodes-langchain.lmChatOpenAi` (around the `"OpenAI Chat Model"` node from V10). Replace it with an `Execute Workflow` node that invokes `DPO-Proxy V1` and wire its output into the same downstream nodes.

Do the edit manually in n8n UI (more reliable than JSON surgery), then re-export the workflow as JSON into the V11 file:

1. In n8n, open the imported `Luna Voice + Telegram V11` (after first importing V10 and renaming).
2. Delete the `OpenAI Chat Model` node.
3. Add `Execute Workflow` node pointing to `DPO-Proxy V1`. Fields:
   - Workflow: `DPO-Proxy V1`
   - Source: Parameters
   - Input: `{ prompt: <the prompt expression from the previous chain>, targetLlm: "gpt-4o-mini", model: "gpt-4o-mini", agent: "luna" }`
4. Connect downstream consumers: read `$json.text` instead of the previous message field.
5. Add a post-node `If blocked` that returns a fallback Telegram message if `$json.blocked === true`.
6. Save and export the workflow as JSON → overwrite `Luna Voice + Telegram V11.json`.

- [ ] **Step 4: Smoke test**

In n8n UI, trigger the workflow with a test Telegram message. Verify:
- Inbound PII (phone/name) arrives.
- `DPO-Proxy V1` is invoked (visible in n8n execution log).
- Outbound message to the user contains de-anonymised data.

- [ ] **Step 5: Commit**

```bash
git add "projekte/n8n-workflows/Luna Voice + Telegram V11.json"
git commit -m "feat(n8n): Luna V11 routes OpenAI calls through DPO-Proxy"
```

---

### Task 22: Migrate `Paperclip CEO V3` → `V4`

**Files:**
- Create: `projekte/n8n-workflows/Paperclip CEO - Voice & Telegram V4.json`

- [ ] **Step 1: Copy V3 to V4**

Run:
```bash
cp "projekte/n8n-workflows/Paperclip CEO - Voice & Telegram V3.json" "projekte/n8n-workflows/Paperclip CEO - Voice & Telegram V4.json"
```

- [ ] **Step 2: Update `name` field inside V4 JSON**

Change the top-level `"name": "Paperclip CEO - Voice & Telegram V3"` → `"Paperclip CEO - Voice & Telegram V4"`.

- [ ] **Step 3: Replace OpenAI Chat Model node via n8n UI**

Same procedure as Task 21, Step 3, applied to this workflow:
1. Import V4 into n8n.
2. Delete OpenAI Chat Model node.
3. Add Execute Workflow → `DPO-Proxy V1` with `{ prompt, targetLlm: "gpt-4o-mini", model: "gpt-4o-mini", agent: "ceo-voice" }`.
4. Rewire downstream consumers to read `$json.text`.
5. Add blocked-branch fallback.
6. Re-export to V4 JSON.

- [ ] **Step 4: Smoke test**

Trigger via Telegram. Verify DPO-Proxy is invoked and response is de-anonymised.

- [ ] **Step 5: Commit**

```bash
git add "projekte/n8n-workflows/Paperclip CEO - Voice & Telegram V4.json"
git commit -m "feat(n8n): CEO V4 routes OpenAI calls through DPO-Proxy"
```

---

## Phase 9 — Policy Document

### Task 23: DPO-Policy.md

**Files:**
- Create: `projekte/dpo/DPO-Policy.md`

- [ ] **Step 1: Write policy document**

```markdown
# DPO-Policy

**Stand:** 2026-04-21
**Review-Kadenz:** vierteljährlich (nächster Review: 2026-07-21)
**DSB:** Walter Schönenbröcher (de-facto, formale Benennung nicht erforderlich bei <10 MA und keiner systematischen Art-9-Verarbeitung nach §38 BDSG)

## Abgedeckt durch DPO-Gate

Alle Aufrufe auf dieser Liste müssen durch den DPO-Service laufen (technisch erzwungen):

| Pfad | Deckung | Durchsetzung |
|---|---|---|
| n8n-Workflows → OpenAI/Anthropic direkt | ✅ Pflicht | Sub-Workflow `DPO-Proxy V1`; direkte OpenAI-Nodes in Produktions-Workflows sind unzulässig |
| TS-Code → Anthropic/OpenAI direkt | ✅ Pflicht | Über `createDpoClient()` aus `paperclip-dpo` |

## Nicht abgedeckt (bewusst)

Diese Systeme rufen externe LLMs auf, können aber technisch nicht transparent gegated werden. Kontrolle erfolgt organisatorisch:

| Adapter | Grund | Mitigation |
|---|---|---|
| `claude-local` | Agentisches CLI mit Filesystem-Zugriff; die CLI ruft Anthropic selbst auf, nach dem Prompt-Hand-off ist der Adapter blind für weiteren Traffic | Keine Kundendaten in Dateien, die von diesen Agenten referenziert werden. Für PII-haltige Aufgaben lokale LLMs (LM Studio) nutzen |
| `codex-local` | Analog | Analog |
| `cursor-local` | Analog | Analog |
| `gemini-local` | Analog | Analog |
| `opencode-local` | Analog | Analog |
| `openclaw-gateway` | Routing zum Paperclip-Gateway (extern betrieben) | Auftragsverarbeitungsvertrag mit Gateway-Betreiber als Kontroll-Pfad |

## Vertrauenswürdige lokale LLMs (kein DPO nötig)

Daten verlassen den LAN-Perimeter nicht:

| Host | Endpoint | Einsatz |
|---|---|---|
| Mac Studio | `http://localhost:1234`, `http://192.168.2.10:1234` (je nach Konfiguration) | CEO, CTO, CPO, CMO, CRO, Creative Director — lokale LLM-Aufrufe via LM Studio |
| Windows-CFO-Host | `http://192.168.2.181:1234` | CFO (DSGVO-kritische Finanzdaten) |

## Regel für Agenten-Konfiguration

- **Cloud-LLMs (Claude/OpenAI/Gemini):** nur für PII-freie oder bereits anonymisierte Aufgaben, oder im CLI-Modus ohne Dokument-Referenzen.
- **Lokale LLMs:** Default für alles mit Kundendaten-Berührung.
- Neue Agenten-Adapter müssen im Review vor Produktionseinsatz gegen diese Liste geprüft werden.

## Review-Checkliste (vierteljährlich)

- [ ] Sind neue Adapter hinzugekommen? In Tabelle oben einsortieren.
- [ ] Sind neue n8n-Workflows hinzugekommen, die extern rausrufen? Über `DPO-Proxy V1` geroutet?
- [ ] Gab es Art-9-Alerts im letzten Quartal? Ursache dokumentieren.
- [ ] Telegram-Alerts im letzten Quartal gezählt und nach Typ klassifiziert.
- [ ] Audit-Log-Verzeichnis (`/var/paperclip/dpo/audit/`) noch schreibbar und nicht voll.
- [ ] `DPO_SHARED_KEY` älter als 12 Monate? Rotation planen.

## Eskalationspfad bei Verstoß

1. Verstoß bemerkt (z.B. direkter OpenAI-Call in neuem Workflow) → sofort in Paperclip-Issue dokumentieren, betroffener Call deaktivieren.
2. Prüfung, ob Daten bereits übertragen wurden (Audit-Log-Abgleich).
3. Ggf. Meldung nach Art. 33 DSGVO an zuständige Aufsichtsbehörde (Brandenburg: LDA Brandenburg) binnen 72h, wenn Risiko für Betroffene besteht.

## DSGVO-Artikel-Mapping

| Artikel | Umsetzung |
|---|---|
| Art. 25 (Privacy by Design) | DPO-Gate als technische Vorkehrung |
| Art. 32 (Pseudonymisierung) | AES-verschlüsselte Mapping-DB |
| Art. 28 (Auftragsverarbeitung) | Audit-Log dokumentiert Empfänger |
| Art. 30 (Verarbeitungsverzeichnis) | Audit-Log als Datenbasis (formaler Generator = Follow-up) |
| Art. 9 (Besondere Kategorien) | Veto-Modus + Telegram-Alert |
```

- [ ] **Step 2: Commit**

```bash
git add projekte/dpo/DPO-Policy.md
git commit -m "docs(dpo): policy document with coverage table and review checklist"
```

---

## Phase 10 — Final Smoke Test

### Task 24: End-to-end smoke test

**Files:**
- Create: `paperclip-dpo-service/scripts/smoke.sh`

- [ ] **Step 1: Create smoke script**

```bash
#!/usr/bin/env bash
set -euo pipefail

URL="${1:-http://localhost:4711}"
KEY="${DPO_SHARED_KEY:?DPO_SHARED_KEY required}"

echo "==> GET /health"
curl -s -f "$URL/health" | tee /dev/stderr
echo

echo "==> POST /anonymize"
RESP=$(curl -s -f \
  -H "x-dpo-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"text":"Hi Max Mustermann (max@whitestag.de)","targetLlm":"gpt-4o","agent":"smoke"}' \
  "$URL/anonymize")
echo "$RESP"

MID=$(echo "$RESP" | node -e 'process.stdin.on("data",b=>console.log(JSON.parse(b).mappingId||""))')
ATEXT=$(echo "$RESP" | node -e 'process.stdin.on("data",b=>console.log(JSON.parse(b).anonymizedText||""))')

if [[ -z "$MID" ]]; then echo "anonymize did not return mappingId (blocked?)" >&2; exit 1; fi

echo "==> POST /deanonymize"
curl -s -f \
  -H "x-dpo-key: $KEY" \
  -H "content-type: application/json" \
  -d "{\"mappingId\":\"$MID\",\"text\":\"Reply to $ATEXT\"}" \
  "$URL/deanonymize"
echo

echo "smoke OK"
```

- [ ] **Step 2: Make executable**

Run: `chmod +x paperclip-dpo-service/scripts/smoke.sh`

- [ ] **Step 3: Run smoke test against installed service**

Run:
```bash
DPO_SHARED_KEY=$(security find-generic-password -s ai.whitestag.paperclip-dpo-key -w) \
  paperclip-dpo-service/scripts/smoke.sh
```

Expected: each step prints JSON; final "smoke OK". Verifies anonymize roundtrip works end-to-end on the live service.

- [ ] **Step 4: Commit**

```bash
git add paperclip-dpo-service/scripts/smoke.sh
git commit -m "chore(dpo-service): end-to-end smoke script"
```

---

## Done Criteria

- [ ] `paperclip-dpo-service` runs under launchd on Mac Studio, reachable at `http://192.168.2.X:4711`.
- [ ] All four HTTP endpoints (`/health`, `/anonymize`, `/deanonymize`, `/safe-call`) respond correctly.
- [ ] `X-DPO-Key` auth enforced on three protected endpoints.
- [ ] n8n sub-workflow `DPO-Proxy V1` imported, activated, smoke-tested.
- [ ] Parent workflows V11 (Luna) and V4 (CEO Voice) route OpenAI calls through `DPO-Proxy V1`.
- [ ] `createDpoClient()` available from `paperclip-dpo` for future TS callers.
- [ ] `projekte/dpo/DPO-Policy.md` committed, covers which adapters are/aren't gated.
- [ ] Monitor loop alerts on Art-9-block, 3 classifier fails, or >10 blocks/h.
- [ ] Telegram alerts fire directly via `api.telegram.org` (not via n8n).
- [ ] Smoke script passes end-to-end.
- [ ] All unit tests green; opt-in integration test available.
