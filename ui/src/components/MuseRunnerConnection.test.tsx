// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MuseConnectionDetails } from "./MuseRunnerConnection";
import { MuseConnectionChecks } from "./new-agent/ExternalAgentInviteContent";
import { museConnectionState } from "@/hooks/useMuseConnection";
import { museConnection, stoppedMuseConnection, museStopBoundary } from "../../storybook/stories/external-agent-invite/muse-fixtures";
import type { MuseConnection } from "@paperclipai/shared";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement; let root: Root;
const handlers = { onTest: vi.fn(), onRepair: vi.fn(), onPause: vi.fn(), onDisconnect: vi.fn(), onRefresh: vi.fn(), onAttest: vi.fn() };
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); vi.clearAllMocks(); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
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
  expect(handlers.onAttest).toHaveBeenCalledWith({ boundary: museStopBoundary, expectedRevision: stoppedMuseConnection.binding!.revision, workerStopped: true });
  expect(container.textContent).toContain("does not resolve or replay those effects");
  expect(button("Connect Muse").disabled).toBe(true);
});
it("withdraws an attestation when the server boundary or revision changes", async () => {
  await render(stoppedMuseConnection);
  await act(async () => button("Attest this worker stopped").click());
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await render({ ...stoppedMuseConnection, binding: { ...stoppedMuseConnection.binding!, revision: 8 } });
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
