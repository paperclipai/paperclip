# Her Workdesk PWA Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a mobile-first Her Workdesk PWA surface inside the existing Paperclip app so the user can authenticate, send text requests to 헤르, and monitor 페퍼 status from a phone.

**Architecture:** Implement an isolated `/mobile` route in the existing Vite/React UI plus `/api/mobile/*` routes in the existing Express server. This slightly deviates from the sidecar-first preference in the design because codebase inspection showed Paperclip already serves a PWA shell (`sw.js`, `site.webmanifest`, SPA fallback), making an isolated in-repo mobile route lower-risk and faster than adding a new workspace app.

**Tech Stack:** Express 5, TypeScript, React 19, React Router, TanStack Query, Vitest, Supertest, existing Paperclip DB/services.

---

## Ground Rules

- Use strict TDD for production behavior: test first, run and confirm failure, implement, run and confirm pass.
- Keep all changes isolated to `server/src/mobile/*`, `server/src/routes/mobile.ts`, `ui/src/mobile/*`, and minimal route mounting in existing app files.
- Do not alter existing Paperclip board behavior beyond adding a `/mobile` route and `/api/mobile/*` API.
- Do not expose Telegram/Hermes/Paperclip secrets to the UI bundle.
- Do not touch existing uncommitted user changes unless the file is explicitly listed in a task.
- Commit after each task.

## Implementation Decision

Use integrated isolated route instead of a new sidecar package for MVP:

- Existing app already has service worker registration and static PWA assets.
- Adding another workspace app would require pnpm workspace/lock churn and a second dev server.
- `/mobile` can be visually and logically separate without polluting the main board navigation.
- If this MVP grows, it can be extracted to a sidecar later because mobile DTOs are isolated under `/api/mobile`.

## Task 1: Add mobile API DTO and status mapping tests

**Objective:** Define mobile API types and pure mapping helpers for summary cards, issue states, and agent states.

**Files:**
- Create: `server/src/mobile/types.ts`
- Create: `server/src/mobile/status.ts`
- Create: `server/src/mobile/status.test.ts`

**Step 1: Write failing test**

Create `server/src/mobile/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMobileSummary, normalizeAgentStatus, normalizeIssueStatus } from "./status.js";

describe("mobile status mapping", () => {
  it("normalizes issue statuses into mobile buckets", () => {
    expect(normalizeIssueStatus("in_progress")).toBe("running");
    expect(normalizeIssueStatus("todo")).toBe("review_needed");
    expect(normalizeIssueStatus("blocked")).toBe("blocked");
    expect(normalizeIssueStatus("done")).toBe("done");
    expect(normalizeIssueStatus("unknown-status")).toBe("review_needed");
  });

  it("normalizes agent statuses into mobile buckets", () => {
    expect(normalizeAgentStatus("idle")).toBe("idle");
    expect(normalizeAgentStatus("running")).toBe("running");
    expect(normalizeAgentStatus("error")).toBe("error");
    expect(normalizeAgentStatus("blocked")).toBe("blocked");
    expect(normalizeAgentStatus(null)).toBe("idle");
  });

  it("builds summary counts from mobile issue rows", () => {
    const summary = buildMobileSummary([
      { id: "1", title: "A", status: "running", priority: "high", assigneeName: "Engineer", updatedAt: null, risk: null },
      { id: "2", title: "B", status: "blocked", priority: null, assigneeName: null, updatedAt: null, risk: "needs fix" },
      { id: "3", title: "C", status: "done", priority: null, assigneeName: null, updatedAt: null, risk: null },
      { id: "4", title: "D", status: "review_needed", priority: null, assigneeName: null, updatedAt: null, risk: null },
    ]);

    expect(summary.counts).toEqual({ running: 1, reviewNeeded: 1, blocked: 1, done: 1 });
    expect(summary.health).toBe("degraded");
  });
});
```

**Step 2: Run test to verify RED**

Run:

```bash
pnpm --filter @paperclipai/server exec vitest run src/mobile/status.test.ts
```

Expected: FAIL because `server/src/mobile/status.ts` does not exist.

**Step 3: Add types**

Create `server/src/mobile/types.ts`:

```ts
export type MobileIssueStatus = "running" | "review_needed" | "blocked" | "done";
export type MobileAgentStatus = "idle" | "running" | "error" | "blocked";
export type MobileHealth = "ok" | "degraded" | "error";

export interface MobileIssueRow {
  id: string;
  title: string;
  status: MobileIssueStatus;
  priority: string | null;
  assigneeName: string | null;
  updatedAt: string | null;
  risk: string | null;
}

export interface MobileAgentRow {
  id: string;
  name: string;
  role: string | null;
  status: MobileAgentStatus;
  lastActivityAt: string | null;
  usageSummary: string | null;
}

export interface MobileSummary {
  health: MobileHealth;
  counts: {
    running: number;
    reviewNeeded: number;
    blocked: number;
    done: number;
  };
  latestReport: {
    id: string;
    title: string;
    responsibleRole: string | null;
    updatedAt: string | null;
  } | null;
}
```

**Step 4: Add implementation**

Create `server/src/mobile/status.ts`:

```ts
import type { MobileAgentStatus, MobileIssueRow, MobileIssueStatus, MobileSummary } from "./types.js";

export function normalizeIssueStatus(status: string | null | undefined): MobileIssueStatus {
  switch ((status ?? "").toLowerCase()) {
    case "in_progress":
    case "running":
    case "active":
      return "running";
    case "blocked":
    case "error":
      return "blocked";
    case "done":
    case "closed":
    case "completed":
      return "done";
    default:
      return "review_needed";
  }
}

export function normalizeAgentStatus(status: string | null | undefined): MobileAgentStatus {
  switch ((status ?? "").toLowerCase()) {
    case "running":
    case "working":
      return "running";
    case "error":
    case "failed":
      return "error";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
}

export function buildMobileSummary(issues: MobileIssueRow[]): MobileSummary {
  const counts = {
    running: issues.filter((issue) => issue.status === "running").length,
    reviewNeeded: issues.filter((issue) => issue.status === "review_needed").length,
    blocked: issues.filter((issue) => issue.status === "blocked").length,
    done: issues.filter((issue) => issue.status === "done").length,
  };

  return {
    health: counts.blocked > 0 ? "degraded" : "ok",
    counts,
    latestReport: null,
  };
}
```

**Step 5: Run test to verify GREEN**

Run:

```bash
pnpm --filter @paperclipai/server exec vitest run src/mobile/status.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/src/mobile/types.ts server/src/mobile/status.ts server/src/mobile/status.test.ts
git commit -m "feat: add mobile status DTO mapping"
```

## Task 2: Add mobile chat store with retry lifecycle

**Objective:** Provide an in-memory single-user chat timeline for MVP with message creation, failure, assistant response, and retry state transitions.

**Files:**
- Create: `server/src/mobile/chat-store.ts`
- Create: `server/src/mobile/chat-store.test.ts`

**Step 1: Write failing test**

Create `server/src/mobile/chat-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMobileChatStore } from "./chat-store.js";

describe("mobile chat store", () => {
  it("records outgoing messages and assistant responses", () => {
    const store = createMobileChatStore({ now: () => new Date("2026-05-16T00:00:00.000Z") });
    const userMessage = store.createUserMessage("헤르, 상태 확인해줘");

    expect(userMessage.status).toBe("sent");
    expect(userMessage.role).toBe("user");

    const assistantMessage = store.createAssistantMessage("확인했어.", userMessage.id);
    expect(assistantMessage.role).toBe("assistant");
    expect(store.list()).toHaveLength(2);
    expect(store.list()[1].replyToId).toBe(userMessage.id);
  });

  it("marks failed messages retryable", () => {
    const store = createMobileChatStore({ now: () => new Date("2026-05-16T00:00:00.000Z") });
    const message = store.createUserMessage("실패 테스트");

    store.markFailed(message.id, "Telegram delivery failed");
    expect(store.list()[0].status).toBe("failed");
    expect(store.list()[0].error).toBe("Telegram delivery failed");

    const retried = store.retry(message.id);
    expect(retried.status).toBe("sent");
    expect(retried.error).toBeNull();
  });
});
```

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/server exec vitest run src/mobile/chat-store.test.ts
```

Expected: FAIL because implementation file does not exist.

**Step 3: Add implementation**

Create `server/src/mobile/chat-store.ts`:

```ts
export type MobileChatRole = "user" | "assistant";
export type MobileChatStatus = "sent" | "failed";

export interface MobileChatMessage {
  id: string;
  role: MobileChatRole;
  text: string;
  status: MobileChatStatus;
  createdAt: string;
  replyToId: string | null;
  error: string | null;
}

export interface MobileChatStore {
  list(): MobileChatMessage[];
  createUserMessage(text: string): MobileChatMessage;
  createAssistantMessage(text: string, replyToId?: string | null): MobileChatMessage;
  markFailed(id: string, error: string): MobileChatMessage;
  retry(id: string): MobileChatMessage;
}

export function createMobileChatStore(opts: { now?: () => Date } = {}): MobileChatStore {
  const now = opts.now ?? (() => new Date());
  const messages: MobileChatMessage[] = [];
  let sequence = 0;

  function nextId() {
    sequence += 1;
    return `mobile-chat-${sequence}`;
  }

  function find(id: string) {
    const message = messages.find((item) => item.id === id);
    if (!message) throw new Error(`Mobile chat message not found: ${id}`);
    return message;
  }

  return {
    list() {
      return [...messages];
    },
    createUserMessage(text: string) {
      const message: MobileChatMessage = {
        id: nextId(),
        role: "user",
        text,
        status: "sent",
        createdAt: now().toISOString(),
        replyToId: null,
        error: null,
      };
      messages.push(message);
      return message;
    },
    createAssistantMessage(text: string, replyToId = null) {
      const message: MobileChatMessage = {
        id: nextId(),
        role: "assistant",
        text,
        status: "sent",
        createdAt: now().toISOString(),
        replyToId,
        error: null,
      };
      messages.push(message);
      return message;
    },
    markFailed(id: string, error: string) {
      const message = find(id);
      message.status = "failed";
      message.error = error;
      return { ...message };
    },
    retry(id: string) {
      const message = find(id);
      message.status = "sent";
      message.error = null;
      return { ...message };
    },
  };
}
```

**Step 4: Run GREEN**

```bash
pnpm --filter @paperclipai/server exec vitest run src/mobile/chat-store.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/src/mobile/chat-store.ts server/src/mobile/chat-store.test.ts
git commit -m "feat: add mobile chat store"
```

## Task 3: Add mobile API routes and route tests

**Objective:** Expose `/api/mobile/summary`, `/api/mobile/issues`, `/api/mobile/agents`, and chat endpoints with token/session protection.

**Files:**
- Create: `server/src/routes/mobile.ts`
- Create: `server/src/__tests__/mobile-routes.test.ts`
- Modify: `server/src/app.ts`

**Step 1: Write failing route tests**

Create `server/src/__tests__/mobile-routes.test.ts` using existing Supertest/Vitest conventions:

```ts
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { mobileRoutes } from "../routes/mobile.js";

function app() {
  const app = express();
  app.use(express.json());
  app.use("/api/mobile", mobileRoutes({
    mobileToken: "test-token",
    telegramUrl: "https://t.me/test_bot",
    loadIssues: async () => [
      { id: "i1", title: "Build app", status: "in_progress", priority: "high", assigneeName: "Engineer", updatedAt: null, risk: null },
    ],
    loadAgents: async () => [
      { id: "a1", name: "Engineer", role: "Engineer", status: "running", lastActivityAt: null, usageSummary: null },
    ],
  }));
  return app;
}

describe("mobile routes", () => {
  it("rejects unauthenticated summary requests", async () => {
    await request(app()).get("/api/mobile/summary").expect(401);
  });

  it("logs in with the configured token and returns a session cookie", async () => {
    const res = await request(app())
      .post("/api/mobile/auth/login")
      .send({ token: "test-token" })
      .expect(200);

    expect(res.headers["set-cookie"]?.[0]).toContain("mobile_session=");
  });

  it("returns summary for authenticated requests", async () => {
    const agent = request.agent(app());
    await agent.post("/api/mobile/auth/login").send({ token: "test-token" }).expect(200);

    const res = await agent.get("/api/mobile/summary").expect(200);
    expect(res.body.counts.running).toBe(1);
    expect(res.body.telegramUrl).toBe("https://t.me/test_bot");
  });

  it("creates chat messages", async () => {
    const agent = request.agent(app());
    await agent.post("/api/mobile/auth/login").send({ token: "test-token" }).expect(200);

    const res = await agent
      .post("/api/mobile/chat/messages")
      .send({ text: "헤르, 테스트" })
      .expect(201);

    expect(res.body.message.role).toBe("user");
    expect(res.body.message.text).toBe("헤르, 테스트");
  });
});
```

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/server exec vitest run src/__tests__/mobile-routes.test.ts
```

Expected: FAIL because route file does not exist.

**Step 3: Implement `mobileRoutes`**

Create `server/src/routes/mobile.ts`:

- Export `mobileRoutes(deps)` returning `Router()`.
- Use a minimal cookie parser helper for `mobile_session=1`.
- `POST /auth/login`: compare request body token to `deps.mobileToken`; set `HttpOnly`, `SameSite=Lax`, `Path=/api/mobile` cookie.
- `POST /auth/logout`: clear cookie.
- Auth middleware for all non-login routes.
- `GET /summary`: call `deps.loadIssues()`, return `buildMobileSummary(issues)` plus `telegramUrl`.
- `GET /issues`: return issue rows from `deps.loadIssues()`.
- `GET /agents`: return agent rows from `deps.loadAgents()`.
- `GET /reports`: return empty array for MVP unless a future loader is injected.
- `GET /chat/messages`: return chat store list.
- `POST /chat/messages`: create user message, and for MVP add an assistant placeholder response explaining delivery path when no real relay is configured.
- `POST /chat/messages/:id/retry`: retry failed message.

**Step 4: Mount route in `server/src/app.ts`**

- Import `mobileRoutes`.
- Mount under `api.use("/mobile", mobileRoutes(...))` before the `/api` 404.
- For initial data loaders, use DB queries or existing route/service patterns to load first available company issues/agents. Keep this isolated and read-only.
- Use environment variables:
  - `MOBILE_APP_TOKEN`
  - `MOBILE_TELEGRAM_URL` defaulting to `https://t.me/` only if unset is not useful; prefer `null` when unset.

**Step 5: Run GREEN**

```bash
pnpm --filter @paperclipai/server exec vitest run src/__tests__/mobile-routes.test.ts src/mobile/status.test.ts src/mobile/chat-store.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/src/routes/mobile.ts server/src/__tests__/mobile-routes.test.ts server/src/app.ts
git commit -m "feat: expose mobile workdesk API"
```

## Task 4: Add mobile API client and UI data models

**Objective:** Add frontend client functions for the mobile API with typed responses.

**Files:**
- Create: `ui/src/mobile/api.ts`
- Create: `ui/src/mobile/api.test.ts`

**Step 1: Write failing tests**

Create `ui/src/mobile/api.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchMobileSummary, postMobileChatMessage } from "./api";

describe("mobile api client", () => {
  it("fetches mobile summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ counts: { running: 1, reviewNeeded: 0, blocked: 0, done: 0 } }),
    });

    const summary = await fetchMobileSummary(fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith("/api/mobile/summary", { credentials: "include" });
    expect(summary.counts.running).toBe(1);
  });

  it("posts chat messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { id: "1", role: "user", text: "hi", status: "sent" } }),
    });

    const result = await postMobileChatMessage("hi", fetchMock as unknown as typeof fetch);

    expect(fetchMock).toHaveBeenCalledWith("/api/mobile/chat/messages", expect.objectContaining({ method: "POST" }));
    expect(result.message.text).toBe("hi");
  });
});
```

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/api.test.ts
```

Expected: FAIL because `api.ts` does not exist.

**Step 3: Implement client**

Create `ui/src/mobile/api.ts` with:

- Types mirroring mobile DTOs.
- `requestJson(path, options, fetchImpl = fetch)` helper.
- `loginMobile(token)`.
- `logoutMobile()`.
- `fetchMobileSummary()`.
- `fetchMobileIssues(status?)`.
- `fetchMobileAgents()`.
- `fetchMobileReports()`.
- `fetchMobileChatMessages()`.
- `postMobileChatMessage(text)`.
- `retryMobileChatMessage(id)`.

**Step 4: Run GREEN**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/mobile/api.ts ui/src/mobile/api.test.ts
git commit -m "feat: add mobile workdesk API client"
```

## Task 5: Add mobile route shell and login screen

**Objective:** Make `/mobile` render a standalone, high-readability mobile shell with token login.

**Files:**
- Create: `ui/src/mobile/MobileWorkdesk.tsx`
- Create: `ui/src/mobile/MobileWorkdesk.test.tsx`
- Modify: `ui/src/App.tsx`

**Step 1: Write failing UI test**

Create `ui/src/mobile/MobileWorkdesk.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MobileWorkdesk } from "./MobileWorkdesk";

describe("MobileWorkdesk", () => {
  it("renders the mobile login screen", () => {
    render(<MobileWorkdesk initialView="login" />);

    expect(screen.getByText("헤르 워크데스크")).toBeInTheDocument();
    expect(screen.getByLabelText("모바일 토큰")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "로그인" })).toBeInTheDocument();
  });
});
```

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: FAIL because component does not exist.

**Step 3: Implement component shell**

Create `ui/src/mobile/MobileWorkdesk.tsx`:

- Full-height mobile layout with max width around `430px`.
- Header: `헤르 워크데스크` and subtitle `헤르에게 요청하고 페퍼 상태를 확인합니다.`
- Login form with label `모바일 토큰` and button `로그인`.
- Use large touch targets, high contrast, readable spacing.
- Accept `initialView?: "login" | "home"` for tests.

**Step 4: Add route in `ui/src/App.tsx`**

- Import `MobileWorkdesk`.
- Add `<Route path="mobile" element={<MobileWorkdesk />} />` near other top-level routes, outside company-prefix board layout.

**Step 5: Run GREEN**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add ui/src/mobile/MobileWorkdesk.tsx ui/src/mobile/MobileWorkdesk.test.tsx ui/src/App.tsx
git commit -m "feat: add mobile workdesk route shell"
```

## Task 6: Add mobile home/status cards

**Objective:** Render 페퍼 health, counts, latest report preview, and Telegram fallback from `/api/mobile/summary`.

**Files:**
- Modify: `ui/src/mobile/MobileWorkdesk.tsx`
- Modify: `ui/src/mobile/MobileWorkdesk.test.tsx`

**Step 1: Add failing test**

Append a test that renders `initialView="home"` with injected summary data or mocked query client and expects:

- `진행 중`
- `검토 필요`
- `차단됨`
- `완료`
- `Telegram에서 열기`

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: FAIL because home cards are not implemented.

**Step 3: Implement home cards**

- Use TanStack Query to call `fetchMobileSummary`.
- Render loading, error, empty, and success states.
- Home cards should use large numbers and Korean labels.
- Telegram button should render only when `telegramUrl` exists.

**Step 4: Run GREEN**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/mobile/MobileWorkdesk.tsx ui/src/mobile/MobileWorkdesk.test.tsx
git commit -m "feat: add mobile workdesk home summary"
```

## Task 7: Add in-app 헤르 chat UI

**Objective:** Let the user type a text request inside the PWA and see the mobile chat timeline.

**Files:**
- Modify: `ui/src/mobile/MobileWorkdesk.tsx`
- Modify: `ui/src/mobile/MobileWorkdesk.test.tsx`

**Step 1: Add failing chat test**

Add a test that renders home/chat state, enters `헤르, 페퍼 상태 알려줘`, submits it, and expects the message to appear with a sent/failed state.

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: FAIL because chat UI is not implemented.

**Step 3: Implement chat UI**

- Add bottom tab/nav or segmented controls: `홈`, `채팅`, `작업`, `에이전트`, `리포트`.
- Chat view:
  - Message timeline.
  - Textarea with placeholder `헤르에게 요청할 작업을 입력하세요`.
  - Submit button `보내기`.
  - Failed state with retry button.
- Use `fetchMobileChatMessages`, `postMobileChatMessage`, and `retryMobileChatMessage`.

**Step 4: Run GREEN**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/mobile/MobileWorkdesk.tsx ui/src/mobile/MobileWorkdesk.test.tsx
git commit -m "feat: add mobile Her chat UI"
```

## Task 8: Add issue, agent, and report mobile tabs

**Objective:** Add read-only 페퍼 work status, agent status, and report views.

**Files:**
- Modify: `ui/src/mobile/MobileWorkdesk.tsx`
- Modify: `ui/src/mobile/MobileWorkdesk.test.tsx`

**Step 1: Add failing tests**

Add tests for:

- Work tab renders an issue title and status label.
- Agent tab renders an agent name and state.
- Report tab renders empty state `아직 표시할 완료 리포트가 없습니다.`.

**Step 2: Run RED**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: FAIL because tabs are not implemented.

**Step 3: Implement tabs**

- Work tab calls `fetchMobileIssues`.
- Agent tab calls `fetchMobileAgents`.
- Report tab calls `fetchMobileReports`.
- Keep layout card-based and mobile-readable.
- Show responsible role on issue/report cards when available.

**Step 4: Run GREEN**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add ui/src/mobile/MobileWorkdesk.tsx ui/src/mobile/MobileWorkdesk.test.tsx
git commit -m "feat: add mobile Paperclip status tabs"
```

## Task 9: Add PWA/mobile metadata polish

**Objective:** Make the existing PWA install experience clearly identify Her Workdesk where practical without breaking the main board.

**Files:**
- Inspect: `ui/public/site.webmanifest`
- Modify only if safe: `ui/public/site.webmanifest` or add mobile-specific metadata in `MobileWorkdesk` via document title.

**Step 1: Write/adjust test if metadata helper is added**

If adding a helper, write `ui/src/mobile/metadata.test.ts` before implementation.

**Step 2: Implement minimal metadata**

- Set document title to `헤르 워크데스크` while on `/mobile`.
- Avoid changing global manifest name if that would rename the entire Paperclip app unexpectedly.

**Step 3: Verify**

```bash
pnpm --filter @paperclipai/ui exec vitest run src/mobile/MobileWorkdesk.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add ui/src/mobile/MobileWorkdesk.tsx ui/src/mobile/MobileWorkdesk.test.tsx
git commit -m "feat: polish mobile workdesk PWA metadata"
```

## Task 10: Full verification and handoff package

**Objective:** Verify the MVP and produce a concise Korean completion report with responsible parties/roles.

**Files:**
- Modify: `doc/plans/2026-05-16-her-workdesk-pwa-implementation.md` only if plan corrections were required.
- Optional create: `report/2026-05-16-her-workdesk-pwa-verification.md`

**Step 1: Targeted tests**

```bash
pnpm --filter @paperclipai/server exec vitest run src/mobile/status.test.ts src/mobile/chat-store.test.ts src/__tests__/mobile-routes.test.ts
pnpm --filter @paperclipai/ui exec vitest run src/mobile/api.test.ts src/mobile/MobileWorkdesk.test.tsx
```

Expected: PASS.

**Step 2: Typecheck**

```bash
pnpm --filter @paperclipai/server typecheck
pnpm --filter @paperclipai/ui typecheck
```

Expected: PASS.

**Step 3: Build**

```bash
pnpm --filter @paperclipai/ui build
pnpm --filter @paperclipai/server build
```

Expected: PASS.

**Step 4: Manual smoke**

```bash
MOBILE_APP_TOKEN=dev-mobile-token MOBILE_TELEGRAM_URL=https://t.me/hermes_bot pnpm dev
```

Then verify:

- Open `http://127.0.0.1:3100/mobile`.
- Login with `dev-mobile-token`.
- Home summary renders.
- Chat text can be submitted.
- Work/Agent/Report tabs render.
- Mobile browser can access the route on the chosen local network path.

**Step 5: Final commit if needed**

```bash
git status --short
git log --oneline -10
```

Commit any final docs/report only if changed.

## Risks / Watchpoints

- Direct 헤르 response capture may not be fully available through current Telegram/Hermes internals. MVP should clearly show delivery/placeholder state rather than pretending true end-to-end chat is complete.
- Existing board auth and `CloudAccessGate` may redirect `/mobile` if the route is placed incorrectly. Keep `/mobile` top-level and outside company-prefix board routes.
- Existing uncommitted changes in the repository must not be overwritten.
- Single-token auth is for personal/private MVP only. Do not expose publicly without Tailscale/Cloudflare Access/VPN/HTTPS identity layer.

## Definition of Done

- `/mobile` loads a mobile-first Her Workdesk UI.
- User can log in with `MOBILE_APP_TOKEN`.
- User can submit a text request in the app chat.
- App shows 페퍼 summary, issues, agents, and reports/readable empty state.
- API and UI tests pass.
- Server and UI typechecks pass.
- Completion report includes responsible party and role.
