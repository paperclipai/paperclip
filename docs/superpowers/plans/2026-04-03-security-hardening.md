# Security Hardening & Quality Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 14 security/quality alerts identified in the codebase audit across server, DB, frontend, and tooling layers.

**Architecture:** Layer-by-layer approach — server security first (most critical), then DB pool config, then frontend robustness, then dev tooling. i18n (Task 11) is deferrable and must not block security work.

**Tech Stack:** Express 5, React 19, Drizzle ORM, postgres.js, Vitest, pnpm workspaces

**Spec:** `docs/superpowers/specs/2026-04-03-security-hardening-design.md`

**Lockfile note:** Adding new dependencies will modify `pnpm-lock.yaml`. The CI `policy` job blocks lockfile changes unless the branch is named `chore/refresh-lockfile`. Either use that branch convention or land a lockfile refresh PR first.

---

## Phase 1 — Server

### Task 1: Remove hardcoded auth secret

**Files:**
- Modify: `server/src/auth/better-auth.ts:68-70`
- Modify: `server/src/home-paths.ts` (import only)
- Test: `server/src/__tests__/better-auth-secret.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// server/src/__tests__/better-auth-secret.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("resolveAuthSecret", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses BETTER_AUTH_SECRET when set", async () => {
    process.env.BETTER_AUTH_SECRET = "explicit-secret";
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    expect(resolveAuthSecret("authenticated")).toBe("explicit-secret");
  });

  it("falls back to PAPERCLIP_AGENT_JWT_SECRET", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "jwt-secret";
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    expect(resolveAuthSecret("authenticated")).toBe("jwt-secret");
  });

  it("throws in authenticated mode when no secret is set", async () => {
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    expect(() => resolveAuthSecret("authenticated")).toThrow(
      /BETTER_AUTH_SECRET.*PAPERCLIP_AGENT_JWT_SECRET/,
    );
  });

  it("derives deterministic secret in local_trusted mode", async () => {
    const { resolveAuthSecret } = await import("../auth/better-auth.js");
    const secret1 = resolveAuthSecret("local_trusted");
    const secret2 = resolveAuthSecret("local_trusted");
    expect(secret1).toBe(secret2);
    expect(secret1.length).toBeGreaterThan(20);
    expect(secret1).not.toBe("paperclip-dev-secret");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (`resolveAuthSecret` not exported)

```bash
cd server && pnpm vitest run src/__tests__/better-auth-secret.test.ts
```

- [ ] **Step 3: Implement `resolveAuthSecret`**

In `server/src/auth/better-auth.ts`, add at top:

```typescript
import { createHash } from "node:crypto";
import { resolvePaperclipHomeDir } from "../home-paths.js";
```

Add function before `createBetterAuthInstance`:

```typescript
export function resolveAuthSecret(deploymentMode: string): string {
  const explicit =
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (explicit) return explicit;

  if (deploymentMode === "local_trusted") {
    const homePath = resolvePaperclipHomeDir();
    return createHash("sha256")
      .update(`paperclip-local-auth:${homePath}`)
      .digest("hex");
  }

  throw new Error(
    "authenticated mode requires BETTER_AUTH_SECRET or PAPERCLIP_AGENT_JWT_SECRET to be set. " +
    "See https://docs.paperclip.dev/configuration#auth-secret",
  );
}
```

Replace line 70 in `createBetterAuthInstance`:

```typescript
// OLD: const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "paperclip-dev-secret";
const secret = resolveAuthSecret(config.deploymentMode);
```

- [ ] **Step 4: Run test — expect PASS**

```bash
cd server && pnpm vitest run src/__tests__/better-auth-secret.test.ts
```

- [ ] **Step 5: Run full test suite to check no regressions**

```bash
pnpm test:run
```

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/better-auth.ts server/src/__tests__/better-auth-secret.test.ts
git commit -m "fix: remove hardcoded auth secret fallback

Replace 'paperclip-dev-secret' with deployment-mode-aware resolution:
- local_trusted: deterministic secret derived from PAPERCLIP_HOME
- authenticated: fatal error if no explicit secret configured"
```

---

### Task 2: Add rate limiting middleware

**Files:**
- Create: `server/src/middleware/rate-limit.ts`
- Modify: `server/src/middleware/index.ts`
- Modify: `server/src/app.ts:87-96`
- Modify: `server/package.json` (new dep)
- Test: `server/src/__tests__/rate-limit.test.ts` (new)

- [ ] **Step 1: Install dependency**

```bash
cd server && pnpm add express-rate-limit
```

- [ ] **Step 2: Write failing test**

```typescript
// server/src/__tests__/rate-limit.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { createRateLimiters } from "../middleware/rate-limit.js";

describe("rate limiting", () => {
  it("returns 429 after auth limit exceeded", async () => {
    const app = express();
    const { authLimiter } = createRateLimiters({ authMax: 2, writeMax: 100, readMax: 300 });
    app.use("/api/auth", authLimiter);
    app.get("/api/auth/test", (_req, res) => res.json({ ok: true }));

    const agent = request(app);
    await agent.get("/api/auth/test").expect(200);
    await agent.get("/api/auth/test").expect(200);
    await agent.get("/api/auth/test").expect(429);
  });

  it("separates write and read limits", async () => {
    const app = express();
    const { writeLimiter, readLimiter } = createRateLimiters({ authMax: 10, writeMax: 1, readMax: 100 });
    app.use((req, res, next) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        writeLimiter(req, res, next);
      } else {
        readLimiter(req, res, next);
      }
    });
    app.post("/test", (_req, res) => res.json({ ok: true }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const agent = request(app);
    await agent.post("/test").expect(200);
    await agent.post("/test").expect(429);
    await agent.get("/test").expect(200); // read limiter is separate
  });
});
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
cd server && pnpm vitest run src/__tests__/rate-limit.test.ts
```

- [ ] **Step 4: Implement rate limiter factory**

```typescript
// server/src/middleware/rate-limit.ts
import rateLimit from "express-rate-limit";

export interface RateLimitConfig {
  authMax: number;
  writeMax: number;
  readMax: number;
}

export function createRateLimiters(config: RateLimitConfig) {
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: config.authMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });

  const writeLimiter = rateLimit({
    windowMs: 60_000,
    max: config.writeMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS",
    message: { error: "Too many requests, please try again later" },
  });

  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: config.readMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method !== "GET",
    message: { error: "Too many requests, please try again later" },
  });

  return { authLimiter, writeLimiter, readLimiter };
}
```

- [ ] **Step 5: Run test — expect PASS**

- [ ] **Step 6: Mount in `app.ts`**

In `server/src/app.ts`, add import:

```typescript
import { createRateLimiters } from "./middleware/rate-limit.js";
```

After `const app = express();` (line 87), after helmet (added in Task 3) but before `app.use(express.json(...))`.
**Note:** If implementing in parallel with Task 3, coordinate insertion point. Final order must be: helmet → rate limit config → express.json.

Declare rate limit config:

```typescript
  // Rate limiting
  const rateLimitEnabled = process.env.PAPERCLIP_RATE_LIMIT_ENABLED !== "false";
  const limiters = rateLimitEnabled
    ? createRateLimiters({
        authMax: Number(process.env.PAPERCLIP_RATE_LIMIT_AUTH) || 10,
        writeMax: Number(process.env.PAPERCLIP_RATE_LIMIT_API_WRITE) || 100,
        readMax: Number(process.env.PAPERCLIP_RATE_LIMIT_API_READ) || 300,
      })
    : null;
```

After `app.use(httpLogger);` (line 96), add:

```typescript
  if (limiters) {
    app.use("/api/auth", limiters.authLimiter);
  }
```

After `const api = Router();` (line 139), before `api.use(boardMutationGuard());`:

```typescript
  if (limiters) {
    api.use(limiters.writeLimiter);
    api.use(limiters.readLimiter);
  }
```

- [ ] **Step 7: Export from middleware index**

Add to `server/src/middleware/index.ts`:

```typescript
export { createRateLimiters } from "./rate-limit.js";
```

- [ ] **Step 8: Run full test suite**

```bash
pnpm test:run
```

- [ ] **Step 9: Commit**

```bash
git add server/src/middleware/rate-limit.ts server/src/middleware/index.ts server/src/app.ts server/src/__tests__/rate-limit.test.ts server/package.json
git commit -m "feat: add rate limiting middleware

Three tiers: auth (10/min), API write (100/min), API read (300/min).
Configurable via PAPERCLIP_RATE_LIMIT_* env vars.
Disable with PAPERCLIP_RATE_LIMIT_ENABLED=false behind reverse proxy."
```

---

### Task 3: Add security headers (helmet)

**Files:**
- Modify: `server/src/app.ts:87-89`
- Modify: `server/package.json` (new dep)
- Test: `server/src/__tests__/security-headers.test.ts` (new)

- [ ] **Step 1: Install dependency**

```bash
cd server && pnpm add helmet
```

- [ ] **Step 2: Write failing test**

```typescript
// server/src/__tests__/security-headers.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import helmet from "helmet";
import request from "supertest";

describe("security headers", () => {
  it("sets X-Content-Type-Options header", async () => {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options header", async () => {
    const app = express();
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.get("/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/test");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});
```

- [ ] **Step 3: Run test — expect PASS** (helmet works out of the box)

- [ ] **Step 4: Mount helmet in `app.ts`**

Add import at top of `server/src/app.ts`:

```typescript
import helmet from "helmet";
```

Add as first middleware, before `app.use(express.json(...))` (line 89):

```typescript
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
```

- [ ] **Step 5: Run full test suite**

```bash
pnpm test:run
```

- [ ] **Step 6: Commit**

```bash
git add server/src/app.ts server/src/__tests__/security-headers.test.ts server/package.json
git commit -m "feat: add security headers via helmet

Enables X-Frame-Options, X-Content-Type-Options, HSTS, etc.
CSP and COEP disabled for plugin UI compatibility."
```

---

### Task 4: Restrict CORS on plugin UI

**Files:**
- Modify: `server/src/routes/plugin-ui-static.ts:186-193,475`
- Modify: `server/src/app.ts:241-243`
- Test: `server/src/__tests__/plugin-ui-cors.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// server/src/__tests__/plugin-ui-cors.test.ts
import { describe, it, expect } from "vitest";
import { resolvePluginCorsOrigin } from "../routes/plugin-ui-static.js";

describe("resolvePluginCorsOrigin", () => {
  it("returns origin when hostname matches allowedHostnames", () => {
    const result = resolvePluginCorsOrigin("https://app.example.com", ["app.example.com"]);
    expect(result).toBe("https://app.example.com");
  });

  it("returns null when hostname does not match", () => {
    const result = resolvePluginCorsOrigin("https://evil.com", ["app.example.com"]);
    expect(result).toBeNull();
  });

  it("returns null when origin is missing", () => {
    const result = resolvePluginCorsOrigin(undefined, ["app.example.com"]);
    expect(result).toBeNull();
  });

  it("handles localhost for dev", () => {
    const result = resolvePluginCorsOrigin("http://localhost:3100", ["localhost"]);
    expect(result).toBe("http://localhost:3100");
  });

  it("falls back to wildcard when allowedHostnames is empty (local_trusted mode)", () => {
    const result = resolvePluginCorsOrigin("http://localhost:3100", []);
    expect(result).toBe("*");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `resolvePluginCorsOrigin` and plumb `allowedHostnames`**

In `server/src/routes/plugin-ui-static.ts`, add the helper function:

```typescript
export function resolvePluginCorsOrigin(
  origin: string | undefined,
  allowedHostnames: string[],
): string | null {
  if (!origin) return null;
  // In local_trusted mode, allowedHostnames is typically empty.
  // Preserve wildcard CORS to avoid breaking local plugin dev.
  if (allowedHostnames.length === 0) return "*";
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (allowedHostnames.some((h) => h.toLowerCase() === hostname)) {
      return origin;
    }
  } catch {
    // malformed origin
  }
  return null;
}
```

Extend the `PluginUiStaticRouteOptions` interface (line 186):

```typescript
export interface PluginUiStaticRouteOptions {
  localPluginDir: string;
  allowedHostnames: string[];
}
```

Replace line 475 (`res.set("Access-Control-Allow-Origin", "*");`) with:

```typescript
    const corsOrigin = resolvePluginCorsOrigin(req.headers.origin, opts.allowedHostnames);
    if (corsOrigin) {
      res.set("Access-Control-Allow-Origin", corsOrigin);
    }
```

(Where `opts` is the options parameter already available in the route factory function.)

In `server/src/app.ts` line 241-243, pass `allowedHostnames`:

```typescript
  app.use(pluginUiStaticRoutes(db, {
    localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR,
    allowedHostnames: opts.allowedHostnames,
  }));
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Run full test suite**

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/plugin-ui-static.ts server/src/app.ts server/src/__tests__/plugin-ui-cors.test.ts
git commit -m "fix: replace CORS wildcard with origin validation on plugin UI

Only origins matching allowedHostnames get Access-Control-Allow-Origin."
```

---

### Task 5: Add JWT TTL bounds

**Files:**
- Modify: `server/src/agent-auth-jwt.ts:28-37`
- Test: extend `server/src/__tests__/agent-auth-jwt.test.ts`

- [ ] **Step 1: Write failing test**

Add to the existing test file:

```typescript
describe("jwtConfig TTL bounds", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("clamps TTL to minimum 300s", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "10";
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const token = createLocalAgentJwt("agent-1", "company-1", "claude", "run-1");
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(300);
  });

  it("clamps TTL to maximum 30 days", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "99999999";
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const token = createLocalAgentJwt("agent-1", "company-1", "claude", "run-1");
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(30 * 24 * 60 * 60);
  });

  it("uses configured TTL within bounds", async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const token = createLocalAgentJwt("agent-1", "company-1", "claude", "run-1");
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString());
    expect(payload.exp - payload.iat).toBe(3600);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement bounds in `jwtConfig()`**

In `server/src/agent-auth-jwt.ts`, replace line 34:

```typescript
// OLD:
// ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),

// NEW:
ttlSeconds: clampTtl(parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48)),
```

Add helper above `jwtConfig`:

```typescript
const MIN_TTL_SECONDS = 300;           // 5 minutes
const MAX_TTL_SECONDS = 30 * 24 * 3600; // 30 days

function clampTtl(value: number): number {
  if (value < MIN_TTL_SECONDS) return MIN_TTL_SECONDS;
  if (value > MAX_TTL_SECONDS) return MAX_TTL_SECONDS;
  return value;
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add server/src/agent-auth-jwt.ts server/src/__tests__/agent-auth-jwt.test.ts
git commit -m "fix: clamp JWT TTL to 5min–30day range"
```

---

### Task 6: Redact sensitive fields in logs

**Files:**
- Modify: `server/src/middleware/logger.ts:61-88`
- Test: `server/src/__tests__/log-redaction.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// server/src/__tests__/log-redaction.test.ts
import { describe, it, expect } from "vitest";
import { redactSensitiveFields } from "../middleware/logger.js";

describe("redactSensitiveFields", () => {
  it("redacts password field", () => {
    expect(redactSensitiveFields({ password: "secret123" })).toEqual({ password: "[REDACTED]" });
  });

  it("redacts nested fields", () => {
    const input = { user: { token: "abc", name: "Alice" } };
    const result = redactSensitiveFields(input);
    expect(result).toEqual({ user: { token: "[REDACTED]", name: "Alice" } });
  });

  it("handles arrays", () => {
    const input = { items: [{ apiKey: "key1" }, { name: "ok" }] };
    const result = redactSensitiveFields(input);
    expect(result).toEqual({ items: [{ apiKey: "[REDACTED]" }, { name: "ok" }] });
  });

  it("returns non-objects unchanged", () => {
    expect(redactSensitiveFields("string")).toBe("string");
    expect(redactSensitiveFields(null)).toBe(null);
    expect(redactSensitiveFields(42)).toBe(42);
  });

  it("redacts all sensitive key variants", () => {
    const input = {
      password: "x", secret: "x", token: "x",
      apiKey: "x", api_key: "x", authorization: "x", cookie: "x",
      safe: "keep",
    };
    const result = redactSensitiveFields(input) as Record<string, string>;
    expect(result.safe).toBe("keep");
    expect(result.password).toBe("[REDACTED]");
    expect(result.authorization).toBe("[REDACTED]");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `redactSensitiveFields`**

Add to `server/src/middleware/logger.ts`:

```typescript
const SENSITIVE_KEYS = new Set([
  "password", "secret", "token", "apikey", "api_key", "authorization", "cookie",
]);

export function redactSensitiveFields(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactSensitiveFields);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitiveFields(value);
    }
  }
  return result;
}
```

Apply in `customProps` — wrap both paths:

```typescript
// Error-context path (around line 65-70):
return {
  errorContext: ctx.error,
  reqBody: redactSensitiveFields(ctx.reqBody),
  reqParams: ctx.reqParams,
  reqQuery: ctx.reqQuery,
};

// Direct-body fallback path (around line 74):
if (body && typeof body === "object" && Object.keys(body).length > 0) {
  props.reqBody = redactSensitiveFields(body);
}
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Run full test suite**

- [ ] **Step 6: Commit**

```bash
git add server/src/middleware/logger.ts server/src/__tests__/log-redaction.test.ts
git commit -m "fix: redact sensitive fields in error logs

Recursively redact password, secret, token, apiKey, api_key,
authorization, cookie from reqBody before logging."
```

---

### Task 7: Expand DevUiUrl hostname validation

**Files:**
- Modify: `server/src/routes/plugin-ui-static.ts:331-344`
- Test: `server/src/__tests__/plugin-dev-url-validation.test.ts` (new)

- [ ] **Step 1: Write failing test**

```typescript
// server/src/__tests__/plugin-dev-url-validation.test.ts
import { describe, it, expect } from "vitest";
import { isAllowedDevHost } from "../routes/plugin-ui-static.js";

describe("isAllowedDevHost", () => {
  it("accepts localhost", () => {
    expect(isAllowedDevHost("localhost", [])).toBe(true);
  });

  it("accepts 127.0.0.1", () => {
    expect(isAllowedDevHost("127.0.0.1", [])).toBe(true);
  });

  it("accepts ::1 variants", () => {
    expect(isAllowedDevHost("::1", [])).toBe(true);
    expect(isAllowedDevHost("[::1]", [])).toBe(true);
    expect(isAllowedDevHost("0:0:0:0:0:0:0:1", [])).toBe(true);
  });

  it("accepts hostname in allowedHostnames", () => {
    expect(isAllowedDevHost("dev.example.com", ["dev.example.com"])).toBe(true);
  });

  it("rejects unknown hostname", () => {
    expect(isAllowedDevHost("evil.com", ["dev.example.com"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement `isAllowedDevHost`**

Add to `server/src/routes/plugin-ui-static.ts`:

```typescript
import { isIP } from "node:net";

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
]);

export function isAllowedDevHost(hostname: string, allowedHostnames: string[]): boolean {
  const lower = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(lower)) return true;
  // Strip brackets for IPv6
  const stripped = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  if (LOOPBACK_HOSTS.has(stripped)) return true;
  return allowedHostnames.some((h) => h.toLowerCase() === lower);
}
```

Replace the existing loopback check block (lines 334-339) with:

```typescript
          const devHost = targetUrl.hostname;
          if (!isAllowedDevHost(devHost, opts.allowedHostnames)) {
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Run full test suite**

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/plugin-ui-static.ts server/src/__tests__/plugin-dev-url-validation.test.ts
git commit -m "fix: expand DevUiUrl validation to allowedHostnames + IPv6 variants"
```

---

## Phase 2 — Database

### Task 8: Configure DB connection pool

**Files:**
- Modify: `packages/db/src/client.ts:48-51`
- Modify: `server/src/config.ts:44-79,227-273`
- Modify: `server/src/index.ts:266,427`
- Modify: `.env.example`

- [ ] **Step 1: Write test for pool options**

```typescript
// packages/db/src/__tests__/client-pool.test.ts
import { describe, it, expect, vi } from "vitest";

// Mock postgres to capture options
vi.mock("postgres", () => {
  const mockSql = {} as any;
  const factory = vi.fn(() => mockSql);
  return { default: factory };
});

describe("createDb pool options", () => {
  it("passes custom pool options to postgres", async () => {
    vi.resetModules();
    const postgres = (await import("postgres")).default as unknown as ReturnType<typeof vi.fn>;
    const { createDb } = await import("../client.js");
    createDb("postgres://localhost/test", { maxConnections: 5, idleTimeout: 10 });
    expect(postgres).toHaveBeenCalledWith("postgres://localhost/test", expect.objectContaining({
      max: 5,
      idle_timeout: 10,
      connect_timeout: 10,
    }));
  });

  it("uses defaults when no opts provided", async () => {
    vi.resetModules();
    const postgres = (await import("postgres")).default as unknown as ReturnType<typeof vi.fn>;
    const { createDb } = await import("../client.js");
    createDb("postgres://localhost/test");
    expect(postgres).toHaveBeenCalledWith("postgres://localhost/test", expect.objectContaining({
      max: 20,
      idle_timeout: 30,
    }));
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (createDb does not accept opts yet)

- [ ] **Step 3: Modify `createDb` in `packages/db/src/client.ts`**

Replace lines 48-51:

```typescript
export function createDb(url: string, opts?: { maxConnections?: number; idleTimeout?: number }) {
  const sql = postgres(url, {
    max: opts?.maxConnections ?? 20,
    idle_timeout: opts?.idleTimeout ?? 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return drizzlePg(sql, { schema });
}
```

- [ ] **Step 2: Add config fields in `server/src/config.ts`**

Add to `Config` interface (after line 78):

```typescript
  dbPoolMax: number;
  dbPoolIdleTimeout: number;
```

Add to `loadConfig()` return (after line 272, before closing brace):

```typescript
    dbPoolMax: Math.max(1, Number(process.env.PAPERCLIP_DB_POOL_MAX) || 20),
    dbPoolIdleTimeout: Math.max(0, Number(process.env.PAPERCLIP_DB_POOL_IDLE_TIMEOUT) || 30),
```

- [ ] **Step 3: Pass options in `server/src/index.ts`**

At line 266, change:

```typescript
// OLD: db = createDb(config.databaseUrl);
db = createDb(config.databaseUrl, {
  maxConnections: config.dbPoolMax,
  idleTimeout: config.dbPoolIdleTimeout,
});
```

At line 427, change:

```typescript
// OLD: db = createDb(embeddedConnectionString);
db = createDb(embeddedConnectionString, {
  maxConnections: config.dbPoolMax,
  idleTimeout: config.dbPoolIdleTimeout,
});
```

- [ ] **Step 4: Update `.env.example`**

Append:

```
# PAPERCLIP_RATE_LIMIT_ENABLED=true
# PAPERCLIP_RATE_LIMIT_AUTH=10
# PAPERCLIP_RATE_LIMIT_API_WRITE=100
# PAPERCLIP_RATE_LIMIT_API_READ=300
# PAPERCLIP_DB_POOL_MAX=20
# PAPERCLIP_DB_POOL_IDLE_TIMEOUT=30
```

- [ ] **Step 5: Run full test suite**

```bash
pnpm test:run
```

- [ ] **Step 6: Typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/client.ts server/src/config.ts server/src/index.ts .env.example
git commit -m "feat: configure DB connection pool explicitly

Default max: 20, idle_timeout: 30s, connect_timeout: 10s.
Configurable via PAPERCLIP_DB_POOL_MAX and PAPERCLIP_DB_POOL_IDLE_TIMEOUT."
```

---

## Phase 3 — Frontend

### Task 9: Add global Error Boundary

**Files:**
- Create: `ui/src/components/ErrorBoundary.tsx`
- Modify: `ui/src/main.tsx`
- Modify: `ui/src/components/Layout.tsx`

- [ ] **Step 1: Create ErrorBoundary component**

```typescript
// ui/src/components/ErrorBoundary.tsx
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: "global" | "page";
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback === "page") {
      return (
        <div className="mx-auto max-w-xl py-10">
          <div className="rounded-lg border border-destructive/50 bg-card p-6">
            <h2 className="text-lg font-semibold text-destructive">Something went wrong</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {this.state.error?.message ?? "An unexpected error occurred."}
            </p>
            <a href="/dashboard" className="mt-4 inline-block text-sm text-primary underline">
              Go to Dashboard
            </a>
          </div>
        </div>
      );
    }

    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ textAlign: "center", maxWidth: 400, padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ fontSize: 14, color: "#666", marginBottom: 16 }}>
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "8px 16px", fontSize: 14, cursor: "pointer", border: "1px solid #ccc", borderRadius: 6, background: "#fff" }}
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
```

- [ ] **Step 2: Mount global boundary in `ui/src/main.tsx`**

Add import:

```typescript
import { ErrorBoundary } from "./components/ErrorBoundary";
```

Wrap `<QueryClientProvider>` tree inside `<ErrorBoundary>`:

```typescript
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        {/* ... existing provider tree ... */}
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
```

- [ ] **Step 3: Add page-level boundary in `ui/src/components/Layout.tsx`**

Add import:

```typescript
import { ErrorBoundary } from "./ErrorBoundary";
```

Wrap the content area (around lines 427-434) — the section containing both `<BreadcrumbBar />` and `<Outlet />`:

Find the div at line 410 that contains both BreadcrumbBar and the main+Outlet area. Wrap its children:

```typescript
// Inside the div at line 410, wrap everything in ErrorBoundary:
<ErrorBoundary fallback="page">
  {/* existing BreadcrumbBar + main content */}
</ErrorBoundary>
```

- [ ] **Step 4: Run typecheck and dev server to verify**

```bash
pnpm -r typecheck
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/ErrorBoundary.tsx ui/src/main.tsx ui/src/components/Layout.tsx
git commit -m "feat: add global and page-level Error Boundaries

Global boundary wraps entire app with reload fallback.
Page boundary in Layout preserves sidebar on page errors."
```

---

### Task 10: Code splitting + provider consolidation

**Files:**
- Modify: `ui/src/App.tsx:1-50`
- Create: `ui/src/context/AppProviders.tsx`
- Modify: `ui/src/main.tsx`
- Modify: `ui/src/components/Layout.tsx`

- [ ] **Step 1: Convert heavy page imports to `React.lazy` in `App.tsx`**

Replace the static imports for the 4 heaviest pages:

```typescript
// Replace these static imports:
// import { AgentDetail } from "./pages/AgentDetail";
// import { CompanyImport } from "./pages/CompanyImport";
// import { ExecutionWorkspaceDetail } from "./pages/ExecutionWorkspaceDetail";
// import { PluginManager } from "./pages/PluginManager";

const AgentDetail = lazy(() => import("./pages/AgentDetail").then(m => ({ default: m.AgentDetail })));
const CompanyImport = lazy(() => import("./pages/CompanyImport").then(m => ({ default: m.CompanyImport })));
const ExecutionWorkspaceDetail = lazy(() => import("./pages/ExecutionWorkspaceDetail").then(m => ({ default: m.ExecutionWorkspaceDetail })));
const PluginManager = lazy(() => import("./pages/PluginManager").then(m => ({ default: m.PluginManager })));
```

Add `lazy` and `Suspense` imports:

```typescript
import { lazy, Suspense } from "react";
```

- [ ] **Step 2: Add `<Suspense>` in Layout around content area**

In `ui/src/components/Layout.tsx`, add import:

```typescript
import { Suspense } from "react";
import { PageSkeleton } from "./PageSkeleton";
```

Wrap `<Outlet />` (line 433) in Suspense:

```typescript
<Suspense fallback={<PageSkeleton />}>
  <Outlet />
</Suspense>
```

- [ ] **Step 3: Create `AppProviders.tsx`**

```typescript
// ui/src/context/AppProviders.tsx
import type { ReactNode } from "react";
import { BrowserRouter } from "@/lib/router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CompanyProvider } from "./CompanyContext";
import { LiveUpdatesProvider } from "./LiveUpdatesProvider";
import { SidebarProvider } from "./SidebarContext";
import { PanelProvider } from "./PanelContext";
import { DialogProvider } from "./DialogContext";
import { ToastProvider } from "./ToastContext";
import { ThemeProvider } from "./ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginLauncherProvider } from "../plugins/launchers";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <BrowserRouter>
          <CompanyProvider>
            <ToastProvider>
              <LiveUpdatesProvider>
                <TooltipProvider>
                  <SidebarProvider>
                    <PanelProvider>
                      <PluginLauncherProvider>
                        <DialogProvider>
                          {children}
                        </DialogProvider>
                      </PluginLauncherProvider>
                    </PanelProvider>
                  </SidebarProvider>
                </TooltipProvider>
              </LiveUpdatesProvider>
            </ToastProvider>
          </CompanyProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
```

Note: `BreadcrumbProvider` is NOT in this list — it moves to Layout.

- [ ] **Step 4: Move `BreadcrumbProvider` into Layout**

In `ui/src/components/Layout.tsx`, add import:

```typescript
import { BreadcrumbProvider } from "@/context/BreadcrumbContext";
```

Wrap the div at line 410 (that contains BreadcrumbBar + main) with `<BreadcrumbProvider>`:

```typescript
<BreadcrumbProvider>
  <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "h-full flex-1")}>
    {/* BreadcrumbBar + Outlet content */}
  </div>
</BreadcrumbProvider>
```

- [ ] **Step 5: Simplify `main.tsx`**

Replace the entire provider tree with:

```typescript
import { ErrorBoundary } from "./components/ErrorBoundary";
import { AppProviders } from "./context/AppProviders";

// ... initPluginBridge, service worker, css imports ...

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProviders>
        <App />
      </AppProviders>
    </ErrorBoundary>
  </StrictMode>
);
```

Remove the `queryClient` declaration and all individual provider imports from main.tsx.

- [ ] **Step 6: Run typecheck + dev server**

```bash
pnpm -r typecheck
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/App.tsx ui/src/main.tsx ui/src/context/AppProviders.tsx ui/src/components/Layout.tsx
git commit -m "refactor: code splitting + provider consolidation

Lazy-load AgentDetail, CompanyImport, ExecutionWorkspaceDetail, PluginManager.
Centralize providers in AppProviders.tsx.
Move BreadcrumbProvider into Layout (wraps BreadcrumbBar + Outlet)."
```

---

### Task 11: Full internationalization (DEFERRABLE)

> **This task is the largest in the plan and must NOT block Tasks 1-10 or Task 12. It can be executed as a separate follow-up effort.**

**Files:**
- Create: `ui/src/lib/i18n.ts`
- Create: `ui/src/locales/en/common.json`
- Create: `ui/src/locales/en/pages/*.json` (12 files)
- Create: `ui/src/locales/fr/common.json`
- Create: `ui/src/locales/fr/pages/*.json` (12 files)
- Modify: `ui/src/main.tsx`
- Modify: `ui/package.json` (new deps)
- Modify: All 40+ page/component files

- [ ] **Step 1: Install dependencies**

```bash
cd ui && pnpm add react-i18next i18next i18next-browser-languagedetector
```

- [ ] **Step 2: Create i18n config**

```typescript
// ui/src/lib/i18n.ts
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import commonEn from "../locales/en/common.json";
import commonFr from "../locales/fr/common.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: commonEn },
      fr: { common: commonFr },
    },
    defaultNS: "common",
    fallbackLng: "en",
    interpolation: { escapeValue: true },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
```

- [ ] **Step 3: Create initial locale files**

Create `ui/src/locales/en/common.json` and `ui/src/locales/fr/common.json` with shared keys (actions, status, errors — ~80 keys each).

- [ ] **Step 4: Initialize in `main.tsx`**

Add before `createRoot`:

```typescript
import "./lib/i18n";
```

- [ ] **Step 5: Commit i18n infrastructure**

```bash
git add ui/src/lib/i18n.ts ui/src/locales/ ui/src/main.tsx ui/package.json
git commit -m "feat: add i18n infrastructure with react-i18next

Browser language detection, en/fr common translations.
Lazy namespace loading for page-specific keys."
```

- [ ] **Steps 6-11: Extract page translations batch-by-batch**

For each batch (Dashboard/Issues/Agents/Projects, then Routines/Goals/etc., then Settings/Plugins, then Layout/Sidebar/shared):

1. Create `ui/src/locales/en/pages/<domain>.json`
2. Replace hardcoded strings with `t("pages.<domain>.key")` calls
3. Create `ui/src/locales/fr/pages/<domain>.json`
4. Verify rendering with both languages
5. Commit per batch

- [ ] **Step 12: Add language selector to Instance Settings**

Add a language picker in `ui/src/pages/InstanceGeneralSettings.tsx` that calls `i18n.changeLanguage()`.

- [ ] **Step 13: Commit language selector**

---

## Phase 4 — Tooling

### Task 12: ESLint + Prettier + Coverage + CI

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Create: `.prettierignore`
- Modify: `package.json` (scripts + devDeps)
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/pr.yml`

- [ ] **Step 1: Install dev dependencies**

```bash
pnpm add -Dw typescript-eslint eslint eslint-plugin-react-hooks prettier @vitest/coverage-v8
```

- [ ] **Step 2: Create `eslint.config.js`**

```javascript
// eslint.config.js
import tseslint from "typescript-eslint";
import reactHooksPlugin from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.generated.*", "**/migrations/*.sql", "**/ui-dist/", "**/coverage/"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
```

- [ ] **Step 3: Create `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 120
}
```

- [ ] **Step 4: Create `.prettierignore`**

```
dist/
node_modules/
pnpm-lock.yaml
*.sql
ui-dist/
coverage/
```

- [ ] **Step 5: Add scripts to root `package.json`**

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
"format": "prettier --write .",
"format:check": "prettier --check ."
```

- [ ] **Step 6: Add coverage to `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/db",
      "packages/adapters/codex-local",
      "packages/adapters/opencode-local",
      "server",
      "ui",
      "cli",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "./coverage",
      include: ["server/src/**/*.ts", "packages/*/src/**/*.ts", "cli/src/**/*.ts"],
      exclude: ["**/__tests__/**", "**/*.test.ts", "**/dist/**"],
      thresholds: {
        statements: 50,
        branches: 45,
        functions: 45,
        lines: 50,
      },
    },
  },
});
```

- [ ] **Step 7: Update `.github/workflows/pr.yml`**

Replace lines 114-118 in the `verify` job:

```yaml
      - name: Typecheck
        run: pnpm -r typecheck

      - name: Lint
        run: pnpm lint

      - name: Format check
        run: pnpm format:check

      - name: Run tests with coverage
        run: pnpm test:run --coverage

      - name: Build
        run: pnpm build
```

- [ ] **Step 8: Verify locally**

```bash
pnpm lint
pnpm format:check
pnpm test:run --coverage
```

Fix any lint errors in files modified by this plan only (boy scout rule).

- [ ] **Step 9: Commit**

```bash
git add eslint.config.js .prettierrc .prettierignore vitest.config.ts .github/workflows/pr.yml package.json
git commit -m "feat: add ESLint, Prettier, test coverage to CI

ESLint 9 flat config with typescript-eslint + react-hooks.
Prettier with existing code style conventions.
Vitest coverage with conservative 50% thresholds.
CI: lint + format check + coverage in PR workflow."
```

---

## Execution Order & Dependencies

```
Task 1 (auth secret) ──┐
Task 2 (rate limiting) ─┤
Task 3 (helmet) ────────┤─── independent, can run in parallel
Task 5 (JWT TTL) ───────┤
Task 6 (log redaction) ─┘
         │
Task 7 (DevUiUrl) ──── does the PluginUiStaticRouteOptions interface change + app.ts plumbing
Task 4 (CORS) ─────── depends on Task 7 (consumes allowedHostnames already plumbed)
         │
Task 8 (DB pool) ──── independent
         │
Task 9 (Error Boundary) ──┐
Task 10 (code split + providers) ── depends on Task 9 (Layout changes)
         │
Task 11 (i18n) ──── DEFERRABLE, depends on Task 10
         │
Task 12 (tooling) ──── independent, run last to lint all changes
```

**Soft dependencies:** Tasks 2 and 3 both insert middleware into the same region of `app.ts` (before `express.json()`). If run in parallel by different agents, they will create merge conflicts. Sequence them or have the second agent rebase.

