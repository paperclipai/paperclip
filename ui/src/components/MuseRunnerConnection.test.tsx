// @vitest-environment jsdom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MuseConnectionDetails, MuseRunnerConnection } from "./MuseRunnerConnection";
import { MuseConnectionChecks } from "./new-agent/ExternalAgentInviteContent";
import { museConnectionState } from "@/hooks/useMuseConnection";
import { museConnection, stoppedMuseConnection, museStopBoundary, musePairing } from "../../storybook/support/external-agent-invite/muse-fixtures";
import { museInvitationsApi } from "@/api/museInvitations";
import { MUSE_CLIENT_VERSION, type MuseConnection } from "@paperclipai/shared";

vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => ({ userId: "operator", settled: true, failed: false }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement; let root: Root; let cache: QueryClient | null;
const handlers = { onTest: vi.fn(), onRepair: vi.fn(), onPause: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onAttest: vi.fn(), onAttestDetectorCleanup: vi.fn() };
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
  expect(container.textContent).toContain("Last persisted public receiver contact");
  expect(container.textContent).toContain("Authenticated worker activity");
  expect(container.textContent).toContain("Last verified replyNot observed");
  expect(container.textContent).toContain(`Client version${MUSE_CLIENT_VERSION}`);
  expect(container.textContent).toContain("may lag by up to 30 seconds");
  expect(container.textContent).toContain("Usage and costUnavailable");
  expect(container.textContent).not.toContain("$0");
});
it("retains cleanup and precise worker attestation while disabled without resolving unknown effects", async () => {
  await render(stoppedMuseConnection);
  expect(container.textContent).toContain("Detector removal: not confirmed. Worker quiescence: not confirmed");
  expect(container.textContent).toContain("Cleanup cannot be confirmed through the revoked connection");
  expect(container.textContent).not.toContain("Cleanup capability expires");
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


it("marks public contact unverified and does not promise cleanup through a revoked Vault connection",async()=>{
  const connection=structuredClone(stoppedMuseConnection);
  connection.binding!.cleanup.authenticatedAfterRevocation=false;
  connection.binding!.cleanup.expiresAt=null;
  await render(connection);
  expect(container.textContent).toContain("Public receiver checks are unverified");
  expect(container.textContent).toContain("Cleanup cannot be confirmed through the revoked connection");
  expect(container.textContent).not.toContain("Cleanup capability expires");
});

it("does not reuse historical readiness after the authenticated connection expires", async () => {
  const expired: MuseConnection = { ...museConnection, agentLifecycleState: "ready", binding: {
    ...museConnection.binding!, status: "ready", credentialState: "expired", refreshExpiresAt: null,
    paired: true, receiverDetected: true, backgroundReplyVerified: true,
  } };
  expect(museConnectionState(expired).ready).toBe(false);
  await render(expired);
  expect(container.textContent).toContain("This Muse connection expired. Reconnect Muse with a fresh setup prompt.");
  expect(container.textContent).not.toContain("Muse is ready for tasks");
});


it("withdraws cached readiness after a failed update and restores it only after refresh", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  const ready: MuseConnection = { ...museConnection, agentLifecycleState: "ready", binding: { ...museConnection.binding!,
    status: "ready", backgroundReplyVerified: true, lastVerifiedReplyAt: "2026-10-15T14:59:00Z" } };
  const load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(ready);
  await renderRunner();
  expect(container.textContent).toContain("Muse is ready for tasks");
  const priorReply = lastVerifiedReply();
  load.mockRejectedValueOnce(new Error("Synthetic connection update failed"));
  await act(async () => { await vi.advanceTimersByTimeAsync(5030); });
  expect(container.textContent).toContain("Connection updates paused. Refresh to check the latest evidence.");
  expect(container.textContent).not.toContain("Muse is ready for tasks");
  expect(container.textContent).toContain("Synthetic connection update failed");
  expect(lastVerifiedReply()).toBe(priorReply);
  expect(button("Test background reply").disabled).toBe(true);
  expect(button("Repair connection").disabled).toBe(true);
  expect(button("Disconnect").disabled).toBe(false);
  expect(button("Refresh").disabled).toBe(false);
  await act(async () => button("Refresh").click());
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(container.textContent).toContain("Muse is ready for tasks");
  expect(container.textContent).not.toContain("Connection updates paused");
  expect(button("Test background reply").disabled).toBe(false);
});


function cleanupConnection(): MuseConnection {
  return { ...stoppedMuseConnection, binding: { ...stoppedMuseConnection.binding!, qualification: { id: "88888888-8888-4888-8888-888888888888", expiresAt: "2026-10-15T14:00:00Z" }, cleanup: { ...stoppedMuseConnection.binding!.cleanup, attestationEligible: true, hookScript: `~/hooks/scripts/paperclip-muse-${stoppedMuseConnection.binding!.id}.sh`, detectorEvidence: null } } };
}
async function fillDetectorObservation() {
  await act(async () => button("Record detector removal observation").click());
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [label, value] of [["Registered Muse hook ID", "test-registered-hook"], ["Detector removal observation SHA-256", "d".repeat(64)], ["Detector removal observed at (UTC)", "2026-10-15T14:59:00.000Z"]]) {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Record exact Muse detector removal"] input[type="checkbox"]')!.click());
}
it("records exact detector observation while disabled and reads back authoritative operator provenance", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  const connection = cleanupConnection();
  const load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(connection);
  const record = vi.spyOn(museInvitationsApi, "attestDetectorCleanup").mockImplementation(async () => {
    load.mockResolvedValue({ ...connection, binding: { ...connection.binding!, revision: connection.binding!.revision + 1, cleanup: { ...connection.binding!.cleanup, detectorRemoved: true, attestationEligible: false, detectorEvidence: { bindingId: connection.binding!.id, generation: connection.binding!.generation, qualificationId: connection.binding!.qualification!.id, hookScript: connection.binding!.cleanup.hookScript!, source: "operator_runtime_attestation", recordedAt: new Date().toISOString(), observedAt: new Date().toISOString(), operatorId: "operator", hookId: "test-registered-hook" } } } });
  });
  await renderRunner(); expect(button("Record detector removal observation").disabled).toBe(false);
  await fillDetectorObservation(); expect(container.textContent).toContain(connection.binding!.cleanup.hookScript);
  expect(container.textContent).toContain("include_disabled: true");
  expect(button("Confirm detector observation").disabled).toBe(false);
  const observedAt = "2026-10-15T14:59:00.000Z";
  vi.setSystemTime(new Date("2026-10-15T15:05:00Z"));
  await act(async () => button("Confirm detector observation").click());
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(record).toHaveBeenCalledExactlyOnceWith("company", "agent", expect.objectContaining({ bindingId: connection.binding!.id, generation: connection.binding!.generation, expectedRevision: connection.binding!.revision, qualificationId: connection.binding!.qualification!.id, hookScript: connection.binding!.cleanup.hookScript, observation: { method: "hooks.list", includeDisabled: true, hookId: "test-registered-hook", outcome: "exact_hook_absent", sha256: "d".repeat(64), observedAt } }));
  expect(container.textContent).toContain("Detector removal: operator-attested");
  expect(container.textContent).toContain("not independent provider confirmation");
  expect(container.textContent).toContain("Native effect outcomes remain unknown");
  expect(container.querySelector('[aria-label="Record exact Muse detector removal"]')).toBeNull();
});
it.each(["revision", "binding", "offline"])("invalidates detector confirmation after a %s update", async change => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  const connection = cleanupConnection(), load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(connection);
  const record = vi.spyOn(museInvitationsApi, "attestDetectorCleanup").mockResolvedValue(undefined);
  await renderRunner(); await fillDetectorObservation();
  if (change === "offline") load.mockRejectedValue(new Error("Connection update unavailable"));
  else load.mockResolvedValue({ ...connection, binding: { ...connection.binding!, ...(change === "revision" ? { revision: connection.binding!.revision + 1 } : { id: "55555555-5555-4555-8555-555555555555", generation: 3 }) } });
  await act(async () => { await cache!.refetchQueries({ queryKey: ["muse-binding"] }); await vi.advanceTimersByTimeAsync(30); });
  expect(container.querySelector('[aria-label="Record exact Muse detector removal"]')).toBeNull(); expect(record).not.toHaveBeenCalled();
  if (change === "offline") expect(button("Record detector removal observation").disabled).toBe(true);
});
it("rechecks the server snapshot before submitting a cached detector confirmation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  const connection = cleanupConnection(), load = vi.spyOn(museInvitationsApi, "connection").mockResolvedValue(connection);
  const record = vi.spyOn(museInvitationsApi, "attestDetectorCleanup").mockResolvedValue(undefined);
  await renderRunner(); await fillDetectorObservation();
  load.mockResolvedValue({ ...connection, binding: { ...connection.binding!, revision: connection.binding!.revision + 1 } });
  await act(async () => button("Confirm detector observation").click()); await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  expect(record).not.toHaveBeenCalled(); expect(container.textContent).toContain("Connection changed");
});

it("requires the actual detector listing time and reconfirms every observation edit", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T15:00:00Z"));
  await render(cleanupConnection());
  await fillDetectorObservation();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  const edit = async (label: string, value: string) => act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const confirm = async () => act(async () => container.querySelector<HTMLInputElement>('[aria-label="Record exact Muse detector removal"] input[type="checkbox"]')!.click());
  for (const [label, value] of [["Registered Muse hook ID", "another-registered-hook"], ["Detector removal observation SHA-256", "e".repeat(64)], ["Detector removal observed at (UTC)", "2026-10-15T14:58:00.000Z"]]) {
    expect(button("Confirm detector observation").disabled).toBe(false);
    await edit(label, value);
    expect(button("Confirm detector observation").disabled).toBe(true);
    await confirm();
  }
  for (const value of ["", "not-a-time", "2026-02-30T14:58:00.000Z"]) {
    await edit("Detector removal observed at (UTC)", value); await confirm();
    expect(button("Confirm detector observation").disabled).toBe(true);
  }
  expect(handlers.onAttestDetectorCleanup).not.toHaveBeenCalled();
  await edit("Detector removal observed at (UTC)", "2026-10-15T13:00:00.000Z"); await confirm();
  vi.setSystemTime(new Date("2026-10-15T15:10:00Z"));
  await act(async () => button("Confirm detector observation").click());
  expect(handlers.onAttestDetectorCleanup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ observation: {
    method: "hooks.list", includeDisabled: true, hookId: "another-registered-hook", outcome: "exact_hook_absent",
    sha256: "e".repeat(64), observedAt: "2026-10-15T13:00:00.000Z",
  } }));
});
