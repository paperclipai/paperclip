import { describe, expect, it, vi } from "vitest";
import { createChatSdkRuntime, type CreateChatSdkEndpointRuntimeOptions } from "../../services/chat-sdk-runtime.js";
import { createChatRuntime } from "../../services/chat-runtime.js";
import * as photonClients from "../../services/photon/owned-client.js";
import { memoryPersistence } from "./fixture.js";

const options = (onConstructionAborted: () => Promise<void>): CreateChatSdkEndpointRuntimeOptions & { onConstructionAborted(): Promise<void> } => ({
  companyId: "company", endpointId: "endpoint", logger: "silent", persistence: memoryPersistence(), onConstructionAborted,
  providerConfig: { provider: "imessage-photon", userName: "Agent", intakeAfter: 0,
    credentials: { allocation: "dedicated", projectId: "project", projectSecret: "controlled-secret", lineId: "line", phoneNumber: "+15555550100" } },
  callbacks: { onMessage: async () => {} },
});

describe.each([["SDK registry", createChatSdkRuntime], ["normal SDK and voice registry", createChatRuntime]] as const)("%s", (_label, createRegistry) => {
it("superseded normal registry replacement settles its exact never-constructed sender reservation", async () => {
  // Actual registry queue and generation cancellation. This controlled reservation
  // callback is not SQL, a process-exit claim or physical transport evidence.
  const registry = createRegistry();
  let reservationClosed = false;
  const aborted = vi.fn(async () => { reservationClosed = true; });
  const allocate = vi.spyOn(photonClients, "createOwnedPhotonClient");
  try {
    const replacement = registry.replaceEndpoint(options(aborted));
    const rejected = replacement.then(() => null, error => error);
    const removal = registry.removeEndpoint("endpoint");
    expect(await rejected).toBeInstanceOf(Error);
    await removal;
    expect(allocate).not.toHaveBeenCalled();
    expect(reservationClosed, "a superseded pre-constructor replacement must settle its owned never-created allocation").toBe(true);
    expect(aborted).toHaveBeenCalledOnce();
    expect(registry.hasUnsettledLifecycle()).toBe(false);
  } finally { try { await registry.shutdown(); } finally { vi.restoreAllMocks(); } }
});

it("constructor entry retains uncertain sender responsibility instead of running never-created cleanup", async () => {
  const registry = createRegistry(), failure = new Error("controlled constructor entered and failed");
  const aborted = vi.fn(async () => {});
  const allocate = vi.spyOn(photonClients, "createOwnedPhotonClient").mockImplementation(() => { throw failure; });
  try {
    await expect(registry.replaceEndpoint(options(aborted))).rejects.toBe(failure);
    expect(allocate).toHaveBeenCalledOnce(); expect(aborted).not.toHaveBeenCalled();
  } finally { try { await registry.shutdown(); } finally { vi.restoreAllMocks(); } }
});


it("failed never-created cleanup receipt stays in the normal registry until explicit retirement retry joins", async () => {
  const registry = createRegistry(); await registry.shutdown();
  const failure = new Error("controlled never-created receipt reply lost");
  let allowReply = false, committed = false;
  const aborted = vi.fn(async () => { committed = true; if (!allowReply) throw failure; });
  const allocate = vi.spyOn(photonClients, "createOwnedPhotonClient");
  try {
    const error = await registry.replaceEndpoint(options(aborted)).then(() => null, error => error);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("normal abort error absent");
    expect(error.errors[0]).toBeInstanceOf(Error); expect(error.errors[1]).toBe(failure);
    expect(committed).toBe(true); expect(aborted).toHaveBeenCalledOnce();
    expect(registry.hasUnsettledLifecycle()).toBe(true); expect(allocate).not.toHaveBeenCalled();
    allowReply = true;
    await expect(registry.removeEndpoint("endpoint")).resolves.toBe(true);
    expect(aborted).toHaveBeenCalledTimes(2); expect(registry.hasUnsettledLifecycle()).toBe(false);
    expect(allocate).not.toHaveBeenCalled();
  } finally { allowReply = true; try { await registry.shutdown(); } finally { vi.restoreAllMocks(); } }
});

});
