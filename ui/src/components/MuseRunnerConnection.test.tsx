// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MuseConnectionDetails, MuseRunnerConnection } from "./MuseRunnerConnection";
import { MuseConnectionChecks } from "./new-agent/ExternalAgentInviteContent";
import { museConnectionState } from "@/hooks/useMuseConnection";
import { museConnection, stoppedMuseConnection, museStopBoundary, musePairing } from "../../storybook/stories/external-agent-invite/muse-fixtures";
import { museInvitationsApi } from "@/api/museInvitations";
import type { MuseConnection } from "@paperclipai/shared";

vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "operator", settled: true, failed: false }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement; let root: Root; let cache: QueryClient | null;
const handlers = { onTest: vi.fn(), onRepair: vi.fn(), onPause: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onAttest: vi.fn() };
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); cache = null; vi.clearAllMocks(); });
afterEach(async () => { await act(async () => root.unmount()); cache?.clear(); vi.restoreAllMocks(); container.remove(); vi.useRealTimers(); });
const button = (name: string) => [...container.querySelectorAll("button")].find(b => b.textContent === name)!;
async function render(connection = museConnection) { await act(async () => root.render(<MuseConnectionDetails connection={connection} {...handlers} />)); }

it("does not treat receiver contact as worker verification or lifecycle readiness", async () => {
  const state = museConnectionState(museConnection);
  expect(state.ready).toBe(false);
  await act(async () => root.render(<MuseConnectionChecks state={state} />));
  expect(container.textContent).toContain("Receiver detected: complete");
  expect(container.textContent).toContain("Background reply verified: waiting");
  expect(container.textContent).not.toContain("Muse is ready for tasks");
  const checksPassed: MuseConnection = { ...museConnection, binding: { ...museConnection.binding!, status: "ready", backgroundReplyVerified: true } };
  expect(museConnectionState(checksPassed).ready).toBe(false);
  expect(museConnectionState({ ...checksPassed, agentLifecycleState: "ready", agentStatus: "pending_approval" }).ready).toBe(false);
  expect(museConnectionState({ ...checksPassed, agentLifecycleState: "ready" }).ready).toBe(true);
});
it("shows contact lag, exact last verified reply, version, and unavailable costs", async () => {
  await render();
  expect(container.textContent).toContain("Last persisted receiver contact");
  expect(container.textContent).toContain("Authenticated worker activity");
  expect(container.textContent).toContain("Last verified replyNot observed");
  expect(container.textContent).toContain("Client version1");
  expect(container.textContent).toContain("may lag by up to 10 seconds");
  expect(container.textContent).toContain("Usage and costUnavailable");
  expect(container.textContent).not.toContain("$0");
});
it("retains cleanup and precise worker attestation while disabled without resolving unknown effects", async () => {
  await render(stoppedMuseConnection);
  expect(container.textContent).toContain("Detector removal: acknowledged. Worker quiescence: not confirmed");
  expect(container.textContent).toContain("Native effect outcomes remain unknown");
  await act(async () => button("Attest this worker stopped").click());
  expect(container.textContent).toContain(museStopBoundary.runId);
  expect(button("Confirm worker stopped").disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("Confirm worker stopped").click());
  expect(handlers.onAttest).toHaveBeenCalledWith({ boundary: museStopBoundary, expectedRevision: stoppedMuseConnection.binding!.stop.bindingRevision, workerStopped: true });
  expect(container.textContent).toContain("does not resolve or replay those effects");
  expect(button("Connect Muse").disabled).toBe(true);
});
it.each(["boundary", "revision"])("withdraws an attestation when the server %s changes", async change => {
  await render(stoppedMuseConnection);
  await act(async () => button("Attest this worker stopped").click());
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const stop = { ...stoppedMuseConnection.binding!.stop, ...(change === "revision" ? { bindingRevision: 8 }
    : { boundary: { ...museStopBoundary, stopNonce: "66666666-6666-4666-8666-666666666666" } }) };
  await render({ ...stoppedMuseConnection, binding: { ...stoppedMuseConnection.binding!, stop } });
  expect(container.querySelector('[aria-label="Attest this Muse worker stopped"]')).toBeNull();
  expect(handlers.onAttest).not.toHaveBeenCalled();
});
it("uses no-recent-response wording for an expired independent background test", async () => {
  await render({ ...museConnection, binding: { ...museConnection.binding!, challengeExpiresAt: "2026-01-01T00:00:00Z" } });
  expect(container.textContent).toContain("No recent response.");
  expect(container.textContent).toContain("Silence does not identify a permission problem");
  expect(container.querySelector('a[href="https://muse.ai"]')).not.toBeNull();
});

it("distinguishes a detector removal request from acknowledged removal", async () => {
  const pending = structuredClone(stoppedMuseConnection);
  pending.binding!.cleanup.detectorRemoved = false;
  Object.assign(pending.binding!.cleanup, { detectorRemovalRequested: true });
  await render(pending);
  expect(container.textContent).toContain("Detector removal requested; completion is not confirmed");
  expect(container.textContent).toContain("Detector removal: not confirmed");
  expect(container.textContent).not.toContain("Detector removal: acknowledged");
});

it("uses the stop boundary's old binding revision across a repaired connection refresh", async () => {
  const repaired: MuseConnection = { ...stoppedMuseConnection, binding: { ...stoppedMuseConnection.binding!,
    id: "55555555-5555-4555-8555-555555555555", generation: 3, revision: 1, status: "connected",
    stop: { ...stoppedMuseConnection.binding!.stop, bindingRevision: 8 },
  } };
  await render(repaired);
  await act(async () => button("Attest this worker stopped").click());
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await render({ ...repaired, binding: { ...repaired.binding!, revision: 2 } });
  expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  await act(async () => button("Confirm worker stopped").click());
  expect(handlers.onAttest).toHaveBeenCalledWith({ boundary: museStopBoundary, expectedRevision: 8, workerStopped: true });
});

it("disables attestation until the exact stop binding revision is available", async () => {
  await render({ ...stoppedMuseConnection, binding: { ...stoppedMuseConnection.binding!,
    stop: { ...stoppedMuseConnection.binding!.stop, bindingRevision: null },
  } });
  expect(button("Attest this worker stopped").disabled).toBe(true);
  expect(container.textContent).toContain("Stop binding revision is unavailable");
  await act(async () => button("Attest this worker stopped").click());
  expect(container.querySelector('[aria-label="Attest this Muse worker stopped"]')).toBeNull();
  expect(handlers.onAttest).not.toHaveBeenCalled();
});

it("connects after Disconnect without replacing the revoked historical binding", async () => {
  const load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(museConnection);
  const revoke = vi.spyOn(museInvitationsApi, "revoke").mockImplementation(async () => {
    load.mockResolvedValue({ ...museConnection, binding: { ...museConnection.binding!, status: "revoked", revision: 8 } });
  });
  const nextPairing = { ...musePairing, bindingId: "55555555-5555-4555-8555-555555555555", generation: 3, revision: 1,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  const pair = vi.spyOn(museInvitationsApi, "pair").mockImplementation(async () => {
    load.mockResolvedValue({ ...museConnection, binding: { ...museConnection.binding!, id: nextPairing.bindingId,
      generation: nextPairing.generation, revision: nextPairing.revision, status: "pairing", paired: false } });
    return nextPairing;
  });
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(<QueryClientProvider client={cache!}><MuseRunnerConnection companyId="company" agentId="agent" /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  await act(async () => button("Disconnect").click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(revoke).toHaveBeenCalledWith("company", "agent", { bindingId: museConnection.binding!.id, generation: museConnection.binding!.generation, expectedRevision: 7 });
  expect(button("Connect Muse").disabled).toBe(false);
  await act(async () => button("Connect Muse").click());
  expect(pair).toHaveBeenCalledWith("company", "agent", {});
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(container.textContent).toContain("Copy setup prompt");
});


const lastVerifiedReply = () => [...container.querySelectorAll("dt")].find(label => label.textContent === "Last verified reply")!.nextElementSibling!.textContent;
async function renderRunner() {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => root.render(<QueryClientProvider client={cache!}><MuseRunnerConnection companyId="company" agentId="agent" /></QueryClientProvider>));
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
}

it("polls a retest after an earlier successful reply and shows its expiry without erasing history", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
  const ready: MuseConnection = { ...museConnection, agentLifecycleState: "ready", binding: { ...museConnection.binding!,
    status: "ready", backgroundReplyVerified: true, lastVerifiedReplyAt: "2026-10-10T14:59:00Z" } };
  const load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(ready);
  const expiresAt = new Date(Date.now() + 15_000).toISOString();
  vi.spyOn(museInvitationsApi, "verify").mockImplementation(async () => {
    load.mockResolvedValue({ ...ready, binding: { ...ready.binding!, revision: 8, challengeExpiresAt: expiresAt } });
    return { bindingId: ready.binding!.id, generation: ready.binding!.generation, revision: 8, expiresAt, status: "pending" };
  });
  await renderRunner();
  const previousReply = lastVerifiedReply();
  expect(previousReply).not.toBe("Not observed");
  await act(async () => button("Test background reply").click());
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(container.textContent).toContain("Waiting for Muse to reply to the current background test");
  expect(button("Testing background reply…").disabled).toBe(true);
  expect(lastVerifiedReply()).toBe(previousReply);
  const readsWhileTesting = load.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(load.mock.calls.length).toBeGreaterThan(readsWhileTesting);
  expect(button("Testing background reply…").disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(container.textContent).toContain("No recent response.");
  expect(container.textContent).not.toContain("Muse is ready for tasks");
  expect(lastVerifiedReply()).toBe(previousReply);
  expect(button("Test background reply").disabled).toBe(false);
});

it("finishes a current retest only after the server confirms a new background reply", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
  const ready: MuseConnection = { ...museConnection, agentLifecycleState: "ready", binding: { ...museConnection.binding!,
    status: "ready", backgroundReplyVerified: true, lastVerifiedReplyAt: "2026-10-10T14:59:00Z" } };
  const load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(ready);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  vi.spyOn(museInvitationsApi, "verify").mockImplementation(async () => {
    load.mockResolvedValue({ ...ready, binding: { ...ready.binding!, revision: 8, challengeExpiresAt: expiresAt } });
    return { bindingId: ready.binding!.id, generation: ready.binding!.generation, revision: 8, expiresAt, status: "pending" };
  });
  await renderRunner();
  const previousReply = lastVerifiedReply();
  await act(async () => button("Test background reply").click());
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(container.textContent).toContain("Waiting for Muse to reply to the current background test");
  expect(lastVerifiedReply()).toBe(previousReply);
  load.mockResolvedValue({ ...ready, binding: { ...ready.binding!, revision: 9, lastVerifiedReplyAt: "2026-10-10T15:00:02Z" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(container.textContent).toContain("Muse is ready for tasks");
  expect(container.textContent).not.toContain("Waiting for Muse to reply to the current background test");
  expect(lastVerifiedReply()).not.toBe(previousReply);
  expect(button("Test background reply").disabled).toBe(false);
});
