import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("./external-plugin-fixture.js", () => ({ createPreviewFixture: async () => ({ key: "public.custody.control", packageRoot: fixture.root, close: async () => {} }) }));
vi.mock("./identity-support.js", () => ({ identityWorker: async () => ({ id: "riley", companyId: "company" }) }));
vi.mock("../api.js", async original => ({ ...await original<object>(), pollUntil: async (options: { load(): Promise<unknown>; accept(value: unknown): boolean }) => { const value = await options.load(); if (!options.accept(value)) throw new Error("Synthetic public prerequisite not satisfied"); return value; } }));
import { createInstanceCustody } from "./external-instance-custody.js";
beforeEach(async () => { fixture.root = await mkdtemp(path.join(os.tmpdir(), "custody-public-resume-")); await mkdir(path.join(fixture.root, "dist")); vi.stubGlobal("fetch", () => { throw new Error("No real network allowed in pure custody control"); }); });
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(fixture.root, { recursive: true, force: true }); });
function context(fastReady: boolean, missingReceipt = false, lateRead = false) {
  let phase = "ready"; const requests: string[] = [];
  const preparing = { companyId: "company", agentId: "riley", operationId: "actual-preparing", version: 1, phase: "preparing", hadOwnedSecret: false, returnedOwnedSecret: true };
  const resuming = { companyId: "company", agentId: "riley", operationId: "actual-resume-from-public-plugin-receipt", version: 5, phase: "resuming", hadOwnedSecret: true, returnedOwnedSecret: false };
  const agent = () => ({ id: "riley", companyId: "company", lifecycleState: phase, lifecycleVersion: phase === "paused" ? 4 : phase === "resuming" ? 5 : phase === "returned-ready" ? 6 : 2 });
  const ctx = { input: { nonce: "public-control", fixtures: { company: { id: "company" } }, privateSecrets: [], evidence: async () => {}, api: {
    post: async (url: string) => { requests.push(url); if (url.includes("/api/release")) return {}; if (url === "/api/plugins/install") return { id: "plugin", pluginKey: "public.custody.control", status: "ready" }; if (url.endsWith("/pause")) { phase = "paused"; return agent(); } if (url.endsWith("/resume")) { phase = fastReady ? "returned-ready" : "resuming"; const dto = { ...agent(), lifecycleState: fastReady ? "ready" : "resuming" }; return dto; } throw new Error("Unexpected public POST"); },
    get: async (url: string) => { if (url === "/api/plugins/plugin") return { id: "plugin", status: "ready" }; if (url === "/api/agents/riley") { if (phase === "resuming" || phase === "returned-ready") return { ...agent(), lifecycleState: "ready", lifecycleVersion: 6 }; return agent(); } if (url.includes("/api/custody")) { if (lateRead && ["resuming", "returned-ready"].includes(phase)) vi.spyOn(Date, "now").mockReturnValue(91000); return { ownerAgentId: "riley", receipts: [preparing, ...(!missingReceipt && ["resuming", "returned-ready"].includes(phase) ? [resuming] : [])] }; } throw new Error("Unexpected public GET"); },
    delete: async () => {},
  } } } as unknown as ChatCatalogContext;
  return { ctx, requests };
}
it.each([false, true])("actual public Agent-only response binds real resume receipt even when already ready: %s", async fastReady => {
  const c = context(fastReady); const result = await createInstanceCustody(c.ctx, "synthetic-owned-custody-control");
  expect(result.resumeOperationId).toBe("actual-resume-from-public-plugin-receipt"); expect(result.resumeVersion).toBe(5); expect(result.seedRemoved).toBe(true);
  expect(c.requests.filter(url => url.endsWith("/resume"))).toHaveLength(1); await expect(access(path.join(fixture.root, "custody-input.private"))).rejects.toThrow(); await result.close();
});
it("never fabricates a resume operation when the real public receipt is missing", async () => {
  const c = context(true, true); await expect(createInstanceCustody(c.ctx, "synthetic-owned-custody-control")).rejects.toThrow();
});

it("rejects a matching receipt read only after the original resume deadline", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const c = context(false, false, true);
  await expect(createInstanceCustody(c.ctx, "synthetic-owned-custody-control")).rejects.toThrow();
});
