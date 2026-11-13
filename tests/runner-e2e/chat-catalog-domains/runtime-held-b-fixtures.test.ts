import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const calls = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: vi.fn(async () => { calls.events.push("human-send"); }) }));
vi.mock("./identity-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./identity-support.js")>(),
  openStandingChat: vi.fn(async () => ({ id: "source", conversationState: "waiting" })),
  readAgentResource: vi.fn(async () => ({ status: 403 })),
}));
import { runtimeAgentChatCases } from "./runtime-agent-chat.js";
import { runtimeBuiltInCases } from "./runtime-built-in.js";
import { runtimeResumeCases } from "./runtime-resume.js";
import { currentControllerFile } from "./runtime-recovery.js";
const roots: string[] = [];
afterEach(async () => { calls.events.length = 0; vi.useRealTimers(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("funds both real history-turn scopes before the genuine setup message, without adding another native turn", async () => {
  const ctx = { input: { nonce: "fixture", fixtures: { company: { id: "company" }, agent: { id: "lead" } }, page: {}, api: {
    patch: async () => undefined,
    post: async (url: string, payload: { scopeId: string; amount: number; unpricedUsagePolicy: string }) => {
      expect(url).toBe("/api/companies/company/budgets/policies"); expect(payload.amount).toBe(500); expect(payload.unpricedUsagePolicy).toBe("allow");
      calls.events.push(`fund-${payload.scopeId}`);
    },
    get: async (url: string) => url.endsWith("comments?order=asc") ? [{ id: "reply", authorAgentId: "lead", createdByRunId: "history" }] : { id: "lead", name: "Morgan" },
  } }, issue: () => ({ id: "source", conversationState: "waiting" }), refreshIssue: async () => undefined,
  allRuns: async () => [{ id: "history", status: "succeeded" }] } as unknown as ChatCatalogContext;
  await runtimeAgentChatCases[0]!.setup(ctx);
  expect(calls.events).toEqual(["fund-company", "fund-lead", "human-send"]);
});

it("waits for actual source verification while preserving the protected summarizer's paused identity", async () => {
  vi.useFakeTimers(); let leadReads = 0;
  const get = vi.fn(async (url: string) => {
    if (url === "/api/agents/lead") return ++leadReads === 1 ? { lifecycleState: "verifying", status: "paused" } : { lifecycleState: "ready", status: "idle" };
    if (url.endsWith("summarizer/status")) return { definition: { key: "summarizer" }, agentId: "summarizer", agent: { status: "paused" } };
    return { status: "backlog" };
  });
  const ctx = { input: { fixtures: { company: { id: "company" }, agent: { id: "lead" } }, api: { get } }, allRuns: async () => [] } as unknown as ChatCatalogContext;
  const pending = runtimeBuiltInCases[0]!.verifySetup!(ctx, { worker: { id: "summarizer" }, historicalTask: { id: "history" } });
  await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).passed).toBe(true); expect(leadReads).toBe(2);
  expect(get.mock.calls.some(([url]) => url === "/api/agents/summarizer")).toBe(false);
});

it("rejects a real source verification error instead of forcing ready state", async () => {
  const ctx = { input: { fixtures: { agent: { id: "lead" } }, api: { get: async () => ({ lifecycleState: "error", lifecycleError: "actual failed validation" }) } } } as unknown as ChatCatalogContext;
  await expect(runtimeBuiltInCases[0]!.verifySetup!(ctx, {})).rejects.toThrow("Source runtime verification failed");
});

it("establishes the second budget context only after first saved resume, with explicit synthetic receipt provenance", async () => {
  let imported = false;
  const ctx = { scenario: { query: "Resume Morgan so they can pick up their work." }, input: {
    nonce: "fixture", page: {}, fixtures: { company: { id: "company" }, agent: { id: "lead" } }, evidence: async (_name: string, body: { modelProviderUsage: string }) => {
      expect(body.modelProviderUsage).toContain("Not model/provider usage"); calls.events.push("fixture-evidence");
    }, api: {
      get: async (url: string) => url.endsWith("comments?order=asc") ? [{ id: "first-reply", authorAgentId: "lead", createdByRunId: "first", body: "Morgan is available." }]
        : imported ? { id: "morgan", status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual", "budget"] }
        : { id: "morgan", status: "idle", lifecycleState: "ready" },
      post: async (url: string, payload: { amount?: number; provider?: string; costCents?: number; heartbeatRunId?: string }) => {
        if (url.endsWith("/pause")) calls.events.push("pause-after-first");
        else if (url.endsWith("budgets/policies")) { expect(payload.amount).toBe(100); calls.events.push("positive-hard-cap"); }
        else { expect(url).toContain("cost-events"); expect(payload.provider).toBe("synthetic-eval-import"); expect(payload.costCents).toBe(125);
          expect(payload.heartbeatRunId).toBeUndefined(); imported = true; calls.events.push("public-synthetic-import"); return { id: "receipt" }; }
      },
    },
  }, refreshIssue: async () => undefined, issue: () => ({ id: "source", conversationState: "waiting" }), allRuns: async () => [{ id: "first", status: "succeeded" }] } as unknown as ChatCatalogContext;
  const state = { worker: { id: "morgan" } };
  await runtimeResumeCases[0]!.act!(ctx, state);
  expect(calls.events).toEqual(["pause-after-first", "positive-hard-cap", "public-synthetic-import", "fixture-evidence", "human-send"]);
});

it("reads real prior bytes from the actual isolated source binding, rejecting wrong identity and escaping files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "controller-binding-")); roots.push(root);
  vi.stubEnv("PAPERCLIP_RUNNER_E2E_TEMP_ROOT", root);
  const cwd = path.join(root, "isolated-workspaces", "company", "source"); await mkdir(cwd, { recursive: true });
  await writeFile(path.join(cwd, "website.html"), "<h1>Real prior draft</h1>");
  let binding = "bound";
  const ctx = { input: { fixtures: { company: { id: "company" } }, api: { get: async (url: string) => url.endsWith("/workspace")
    ? { workspace: { id: binding, companyId: "company", cwd } } : { companyId: "company", executionWorkspaceId: "bound" } } },
    refreshIssue: async () => undefined, issue: () => ({ id: "source" }) } as unknown as ChatCatalogContext;
  expect(await currentControllerFile(ctx, "website.html")).toBe("<h1>Real prior draft</h1>");
  binding = "other"; await expect(currentControllerFile(ctx, "website.html")).rejects.toThrow("actual same-company source binding"); binding = "bound";
  await writeFile(path.join(root, "foreign.html"), "wrong"); await symlink(path.join(root, "foreign.html"), path.join(cwd, "escape.html"));
  await expect(currentControllerFile(ctx, "escape.html")).rejects.toThrow("escapes");
  await expect(currentControllerFile(ctx, "../foreign.html")).rejects.toThrow("escapes");
});
