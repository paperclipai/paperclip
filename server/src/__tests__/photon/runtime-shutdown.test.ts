import { expect, it, vi } from "vitest";
import { createChatSdkRuntime, type CreateChatSdkEndpointRuntimeOptions } from "../../services/chat-sdk-runtime.js";
import { PhotonChatAdapter } from "../../services/photon/adapter.js";
import { PhotonReceiver } from "../../services/photon/receiver.js";
import { memoryPersistence } from "./fixture.js";

it("receiver failure still attempts independent SDK close and swallowed adapter failure retains the same runtime for retry", async () => {
  // Controlled receiver/resource faults and memory state ports. Real installed
  // Chat4.39 initialize/shutdown and the actual Runtime/registry remain intact;
  // this proves lifecycle ownership, not network/provider physical closure.
  const adapters: PhotonChatAdapter[] = [];
  vi.spyOn(PhotonChatAdapter.prototype, "initialize").mockImplementation(async function(this:PhotonChatAdapter) { adapters.push(this); });
  vi.spyOn(PhotonReceiver.prototype, "start").mockImplementation(() => undefined);
  const receiverFailure = new Error("controlled receiver close responsibility failure");
  const receiverClose = vi.spyOn(PhotonReceiver.prototype,"close").mockRejectedValueOnce(receiverFailure).mockResolvedValue(undefined);
  const registry = createChatSdkRuntime();
  const options = (endpointId:string):CreateChatSdkEndpointRuntimeOptions => ({ companyId:"company",endpointId,logger:"silent",persistence:memoryPersistence(),
    providerConfig:{provider:"imessage-photon",userName:"Agent",intakeAfter:0,credentials:{allocation:"dedicated",projectId:"project",projectSecret:"controlled-project-secret",lineId:"line",phoneNumber:"+15555550100"}},
    callbacks:{onMessage:async()=>{},onPhotonEvent:async()=>{},onPhotonAssertOwned:async()=>{},onPhotonCheckpoint:async()=>{},onPhotonFailure:async()=>{}} });
  let repairAdapter: (()=>void)|undefined;
  try {
    const first=await registry.replaceEndpoint(options("receiver-fault"));await first.initialize();
    const firstAdapter=adapters[0];if(!firstAdapter)throw new Error("normal Photon adapter absent");
    const firstPhysicalClose=vi.spyOn(firstAdapter.client,"close");
    await expect(registry.removeEndpoint("receiver-fault")).rejects.toBe(receiverFailure);
    expect(registry.get("receiver-fault")).toBeNull();expect(registry.hasUnsettledLifecycle()).toBe(true);
    await expect(first.initialize()).rejects.toThrow("retired");
    expect(firstPhysicalClose.mock.calls.length,"independent Photon SDK close must run even when receiver close rejects").toBeGreaterThan(0);
    await expect(registry.removeEndpoint("receiver-fault")).resolves.toBe(true);
    expect(registry.hasUnsettledLifecycle()).toBe(false);

    const second=await registry.replaceEndpoint(options("adapter-fault"));await second.initialize();
    const secondAdapter=adapters[1];if(!secondAdapter)throw new Error("second normal Photon adapter absent");
    const client=secondAdapter.client,normalClose=client.close.bind(client);
    const adapterFailure=new Error("controlled independent SDK close failure");
    const physicalClose=vi.spyOn(client,"close").mockRejectedValue(adapterFailure);
    repairAdapter=()=>{physicalClose.mockImplementation(normalClose);};
    // Real Chat.shutdown logs/swallow this rejection. Runtime must observe the
    // SAME failed disconnect attempt and keep its retired cleanup owner.
    const failedClose=await registry.removeEndpoint("adapter-fault").then(()=>null,error=>error);
    expect(failedClose).toBeInstanceOf(AggregateError);
    if(!(failedClose instanceof AggregateError))throw new Error("normal adapter failure was swallowed");
    expect(failedClose.errors).toEqual([adapterFailure]);
    expect(physicalClose).toHaveBeenCalledTimes(1); // join is observation, not hidden retry.
    expect(registry.get("adapter-fault")).toBeNull();expect(registry.hasUnsettledLifecycle()).toBe(true);
    await expect(second.initialize()).rejects.toThrow("retired");
    repairAdapter();
    await expect(registry.removeEndpoint("adapter-fault")).resolves.toBe(true);
    expect(physicalClose).toHaveBeenCalledTimes(2);expect(registry.hasUnsettledLifecycle()).toBe(false);
    expect(receiverClose).toHaveBeenCalledTimes(4);
  } finally {
    // The original expected baseline assertion failure still reaches all owned
    // cleanup. Repair only controlled faults, then join the normal registry.
    repairAdapter?.();receiverClose.mockResolvedValue(undefined);
    try { await registry.shutdown(); } finally { vi.restoreAllMocks(); }
  }
});
