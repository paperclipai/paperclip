import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget, chatCatalogOriginalPhaseDeadline } from "./chat-catalog-contract.js";
const observed = vi.hoisted(() => vi.fn());
vi.mock("./chat-catalog-domains/internal-support.js", async importOriginal => ({ ...await importOriginal<object>(), observeInternal: observed }));
import { waitForReply } from "./chat-catalog-domains/identity-support.js";
import { settlePrivilegedChat } from "./chat-catalog-domains/privileged-support.js";
function context(scenarioId = "cli-operations.owned-dev-instance", deadline = 870_000): ChatCatalogContext {
  return { scenario: { id: scenarioId }, input: { execution: { id: `chat-features.runner-opencode.local.${scenarioId}` } }, observationDeadlineAt: deadline,
    issue: () => ({ conversationState: "waiting" }) } as unknown as ChatCatalogContext;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe("selected native phases share the once-created original flow clock", () => {
  it.each(["secrets.secret-proposal", "developer-labs.long-thread-performance", "cli-operations.owned-dev-instance", "recovery.controller-restart", "routines.run-now", "task-coordination.independent-review", "steering.edit-queued-message", "tasks.website-without-project", "inbox-search.archive-partial-failure", "questions-and-approvals.approve-tool-once", "runs-adapters.reset-session"])("%s uses absolute remaining outer budget rather than resetting its shorter cap", scenario => {
    vi.useFakeTimers(); vi.setSystemTime(800_000); const ctx = context(scenario);
    expect(chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000)).toBe(870_000);
    vi.setSystemTime(850_000); expect(chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000)).toBe(870_000);
    expect(ctx.observationDeadlineAt).toBe(870_000);
  });
  it.each(["instance-operations.backup-and-restore", "instance-operations.restart-service", "routines.webhook-trigger", "status-cards.explain-card", "secrets.configure-company-secret", "teams.configure-team", "steering.interrupt-with-direction", "companies.fast-responses"])("future13 %s shares the setup-inclusive original clock", scenario => {
    vi.useFakeTimers(); vi.setSystemTime(800_000); const ctx = context(scenario);
    expect(chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000)).toBe(870_000);
    expect(chatCatalogOriginalPhaseDeadline(ctx)).toBe(870_000);
    vi.setSystemTime(869_999); expect(chatCatalogNativePhaseRemainingBudget(ctx)!()).toBe(1);
    vi.setSystemTime(870_000); expect(() => chatCatalogOriginalPhaseDeadline(ctx)).toThrow(/exhausted/);
  });
  it.each(["secrets.configure-company-secret", "companies.fast-responses"])("actual %s identity helper settles after its old150s cap using only the original remaining clock", async scenario => {
    vi.useFakeTimers(); vi.setSystemTime(50_000); const originalDeadline = scenario === "companies.fast-responses" ? 390_000 : 450_000; const ctx = context(scenario, originalDeadline);
    Object.assign(ctx, { refreshIssue: async () => {}, allRuns: async () => [{ status: Date.now() >= 230_000 ? "succeeded" : "running" }] });
    let completed = false; const pending = waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx)).then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(152_000); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(28_000); await pending; expect(completed).toBe(true);
    expect(ctx.observationDeadlineAt).toBe(originalDeadline);
  });
  it.each(["onboarding.first-work", "routines.plugin-managed-routine", "status-cards.archive-card", "status-cards.other-authors-card", "companies.prompt-injection-guard", "companies.configure-decision-model"])("future13 %s does not receive new phase or UI behavior", scenario => {
    vi.useFakeTimers(); vi.setSystemTime(800_000); const ctx = context(scenario, 1);
    expect(chatCatalogNativePhaseDeadline(ctx, 900_000)).toBe(900_000);
    expect(chatCatalogOriginalPhaseDeadline(ctx)).toBeUndefined();
    expect(chatCatalogNativePhaseRemainingBudget(ctx)).toBeUndefined();
  });
  it("actual existing privileged phase can settle beyond150s without changing native/reply proof", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context();
    observed.mockImplementation(async () => ({ reply: Date.now() >= 180_000 ? "Use the operator path." : "", runs: [{ status: Date.now() >= 180_000 ? "succeeded" : "running" }] }));
    let complete = false; const pending = settlePrivilegedChat(ctx).then(() => { complete = true; });
    await vi.advanceTimersByTimeAsync(152_000); expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(28_000); await pending; expect(complete).toBe(true);
  });
  it("late successful reads, running natives and extra queued rows cannot pass at the deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(869_000); const ctx = context();
    observed.mockImplementation(async () => { vi.setSystemTime(871_000); return { reply: "Use settings", runs: [{ status: "succeeded" }] }; });
    const late = settlePrivilegedChat(ctx).then(() => "accepted", () => "expired");
    await vi.advanceTimersByTimeAsync(3000); expect(await late).toBe("expired");
    for (const runs of [[{ status: "running" }], [{ status: "succeeded" }, { status: "queued" }]]) {
      vi.setSystemTime(869_000); observed.mockResolvedValue({ reply: "Use settings", runs });
      const pending = settlePrivilegedChat(ctx).then(() => "accepted", () => "expired");
      await vi.advanceTimersByTimeAsync(3000); expect(await pending).toBe("expired");
    }
  });
  it("fails closed on missing/expired/nonfinite clocks and never manufactures grace", () => {
    vi.useFakeTimers(); vi.setSystemTime(870_000);
    for (const deadline of [undefined, NaN, Infinity, 870_000, 869_999]) {
      const ctx = context(); Object.assign(ctx, { observationDeadlineAt: deadline });
      expect(() => chatCatalogNativePhaseDeadline(ctx, Date.now() + 180_000)).toThrow(/exhausted or missing/);
      expect(chatCatalogNativePhaseIsTimely(ctx)).toBe(false);
    }
  });
  it("declared followups consume the same clock and never return an unlimited zero timeout", () => {
    vi.useFakeTimers(); vi.setSystemTime(869_999); const remaining = chatCatalogNativePhaseRemainingBudget(context())!;
    expect(remaining()).toBe(1); vi.setSystemTime(870_000); expect(remaining).toThrow(/exhausted/);
    expect(chatCatalogNativePhaseRemainingBudget(context("recovery.post-stop-message"))).toBeUndefined();
  });
  it("keeps the one remaining millisecond and rejects final proof at exact expiry", () => {
    vi.useFakeTimers(); vi.setSystemTime(869_999); const ctx = context();
    expect(chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000) - Date.now()).toBe(1);
    expect(chatCatalogNativePhaseIsTimely(ctx)).toBe(true);
    vi.setSystemTime(870_000); expect(chatCatalogNativePhaseIsTimely(ctx)).toBe(false);
  });
  it.each(["secrets.ask-for-plaintext", "steering.preserve-draft", "routines.read-history", "recovery.post-stop-message", "companies.rename-company"])("%s keeps its existing phase semantics", scenario => {
    vi.useFakeTimers(); vi.setSystemTime(800_000); const ctx = context(scenario, 1);
    expect(chatCatalogNativePhaseDeadline(ctx, 950_000)).toBe(950_000); expect(chatCatalogNativePhaseIsTimely(ctx)).toBe(true);
  });
  it("does not opt another provider/environment lane into the selected scope", () => {
    const ctx = context();
    for (const id of ["chat-features.runner-codex.local.cli-operations.owned-dev-instance", "chat-features.runner-opencode.daytona.cli-operations.owned-dev-instance"]) {
      Object.assign(ctx.input.execution, { id });
      expect(chatCatalogNativePhaseDeadline(ctx, 150_000)).toBe(150_000); expect(chatCatalogNativePhaseIsTimely(ctx)).toBe(true);
    }
  });
});
