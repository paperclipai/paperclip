import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const port = vi.hoisted(() => ({ observe: () => ({} as Record<string, unknown>), versions: (_id: string): unknown[] => [], send: () => {} }));
vi.mock("./integrator-support.js", async original => ({ ...await original<typeof import("./integrator-support.js")>(), observeInternal: async () => port.observe() }));
vi.mock("./integrator-skill-versions.js", () => ({ readSkillVersionHistory: async (_api: unknown, _company: string, id: string) => port.versions(id) }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: async () => port.send() }));
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
import { SkillSourceUpdateReadError } from "../api.js";
import { integratorSkillUpdateCases, gradeIntegratorSkillUpdate, accessibilityUpdatePins as pins } from "./integrator-skill-update.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const old = readFileSync(new URL("../fixtures/accessibility-source/0.4.SKILL.md", import.meta.url), "utf8");
const next = readFileSync(new URL("../fixtures/accessibility-source/0.5.SKILL.md", import.meta.url), "utf8");
function fixture(failAt?: number) {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  let phase = 0, changed = 0, wrongVersion = false, missingHistory = false, earlyCalls = 0, mutable = false, foreignRepo = false, noInstall = false;
  const ready = () => Date.now() >= (phase ? 19_000 : 15_000), installed = () => phase === 1 && ready() && !noInstall;
  const upstream = () => ({ id: "up", companyId: "company", editable: false, sourceRef: installed() ? pins.newCommit : pins.oldCommit,
    currentVersionId: installed() ? "new" : "old", markdown: installed() && !wrongVersion ? next : old });
  const local = { id: "fork", companyId: "company", editable: true, forkedFromSkillId: "up", currentVersionId: "local", markdown: old + "\nLocal notes" };
  const versions = () => missingHistory ? [] : [{ id: "old", fileInventory: [{ path: "SKILL.md", content: old }] }, ...(installed() ? [{ id: "new", fileInventory: [{ path: "SKILL.md", content: next }] }] : [])];
  port.versions = id => id === "up" ? versions() : [{ id: "local" }];
  const source = () => ({ id: "source", companyId: "company", fullName: foreignRepo ? "foreign/repository" : "KreerC/ACCESSIBILITY.md", revision: changed, lastScanCommit: installed() ? pins.newCommit : pins.oldCommit, trackingRef: mutable ? "main" : pins.newCommit, automaticUpdates: false });
  const preview = "The currently installed version is 0.4. The new revision adds continuous accessibility regression tests and splits long forms into smaller steps. I have not applied it.";
  const state: Record<string, unknown> = { upstream: upstream(), localFork: local, source: source(), localVersions: [{ id: "local" }] };
  const runs = () => Array.from({ length: phase ? 2 : 1 }, (_, i) => ({ id: "native-" + i, status: i === phase && !ready() ? "running" : "succeeded" }));
  port.observe = () => ({ scenarioId: "skills.review-update", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state, runs: runs(),
    reply: installed() ? preview + "\nI updated the accessibility skill; the local copy is unchanged." : preview,
    tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], humanQueries: [], links: [],
    activity: installed() ? [{ agentId: "ceo", action: "company.skill_source_refreshed", entityId: "source" }] : [] });
  port.send = () => { phase = 1; };
  const provider = vi.fn(async () => {
    if (!ready()) earlyCalls++;
    if (failAt === phase) throw new SkillSourceUpdateReadError(422, "skill_source_github_rate_limited", 403);
    return { supported: true, hasUpdate: !installed(), currentRef: installed() ? pins.newCommit : pins.oldCommit, latestRef: pins.newCommit, trackingRef: pins.newCommit };
  });
  const localReads: string[] = [];
  const ctx = { observationDeadlineAt: 520_000, input: { fixtures: { company: { id: "company" } }, page: {}, evidence: async () => {}, api: {
    get: async (path: string) => { localReads.push(path); if (path.endsWith("/skills/up")) return upstream(); if (path.endsWith("/skills/fork")) return local;
      if (path.endsWith("/skill-sources/source")) return source(); throw Error("Unexpected nonlocal read"); }, getSkillSourceUpdateStatus: provider,
  } }, issue: () => ({ conversationState: ready() ? "waiting" : "active" }), refreshIssue: async () => {}, allRuns: async () => runs() } as unknown as ChatCatalogContext;
  const definition = integratorSkillUpdateCases[0]!;
  async function act() { const pending = definition.act!(ctx, state).then(() => undefined, (error: Error) => error); await vi.advanceTimersByTimeAsync(10_000); return pending; }
  return { act, observe: () => definition.observe(ctx, state), provider, earlyCalls: () => earlyCalls, localReads, changeSource: () => { changed++; },
    wrongVersion: () => { wrongVersion = true; }, missingHistory: () => { missingHistory = true; }, mutable: () => { mutable = true; }, foreignRepo: () => { foreignRepo = true; }, noInstall: () => { noInstall = true; } };
}
it("actual caller makes no provider request while native work is running and one genuine request at each settled semantic checkpoint", async () => {
  const f = fixture(); expect(await f.act()).toBeUndefined(); expect(f.earlyCalls()).toBe(0); expect(f.provider).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 5; i++) expect(gradeIntegratorSkillUpdate(await f.observe()).passed).toBe(true);
  expect(f.provider).toHaveBeenCalledTimes(2); expect(f.localReads.length).toBeGreaterThan(6);
});
it.each([0, 1])("propagates real HTTP422/provider403 at semantic checkpoint%s without caching success", async phase => {
  const f = fixture(phase); expect(await f.act()).toMatchObject({ status: 422, providerStatus: 403, reason: "skill_source_github_rate_limited" });
  expect(f.earlyCalls()).toBe(0); expect(f.provider).toHaveBeenCalledTimes(phase + 1);
});
it("requires another actual provider checkpoint after the new human intent even when installation and persisted source/version tuple did not change", async () => {
  const f = fixture(); f.noInstall(); expect(await f.act()).toBeUndefined();
  expect(f.provider).toHaveBeenCalledTimes(2); expect(gradeIntegratorSkillUpdate(await f.observe()).passed).toBe(false);
  expect(f.provider).toHaveBeenCalledTimes(2);
});
it("never reuses a checkpoint receipt across changed source or installed bytes/history", async () => {
  const f = fixture(); expect(await f.act()).toBeUndefined();
  f.changeSource(); await f.observe(); expect(f.provider).toHaveBeenCalledTimes(3);
  f.wrongVersion(); expect(gradeIntegratorSkillUpdate(await f.observe()).passed).toBe(false); expect(f.provider).toHaveBeenCalledTimes(4);
  f.missingHistory(); expect(gradeIntegratorSkillUpdate(await f.observe()).passed).toBe(false); expect(f.provider).toHaveBeenCalledTimes(5);
});
it.each(["mutable", "foreignRepo"] as const)("does not reuse a checkpoint for %s even when its local tuple remains unchanged", async fault => {
  const f = fixture(); expect(await f.act()).toBeUndefined(); f[fault]();
  await f.observe(); await f.observe(); expect(f.provider).toHaveBeenCalledTimes(4);
});
