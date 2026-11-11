import { expect, it, vi } from "vitest";
import { createChatSdkRuntime, createChatSdkEndpointRuntime, type CreateChatSdkEndpointRuntimeOptions } from "../../services/chat-sdk-runtime.js";
import { PhotonChatAdapter } from "../../services/photon/adapter.js";
import { PhotonReceiver } from "../../services/photon/receiver.js";
import { memoryPersistence, photonFixture, photonMessage, stream as photonStream } from "./fixture.js";
import * as photonClients from "../../services/photon/owned-client.js";

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


it("saved Photon attachments use the external useful owner and retain failed close for normal retry", async () => {
  // Real endpoint Runtime/attachment and useful-client owners; controlled unary
  // provider bytes/close faults, not a physical transport or SQL assertion.
  const controls = [photonFixture(), photonFixture(), photonFixture()];
  const clients = controls.map(value => value.adapter.client);
  let allocations = 0;
  const allocate = vi.spyOn(photonClients, "createOwnedPhotonClient").mockImplementation(() => {
    const client = clients[allocations++]; if (!client) throw new Error("unexpected useful client allocation"); return client;
  });
  vi.spyOn(PhotonChatAdapter.prototype, "initialize").mockResolvedValue(undefined);
  const debt = vi.fn(async () => {});
  const runtime = createChatSdkEndpointRuntime({ companyId:"company", endpointId:"endpoint", logger:"silent", persistence:memoryPersistence(),
    providerConfig:{provider:"imessage-photon",userName:"Agent",intakeAfter:0,credentials:{allocation:"dedicated",projectId:"project",projectSecret:"controlled-project-secret",lineId:"line",phoneNumber:"+15555550100"}},
    callbacks:{onMessage:async()=>{},onPhotonEvent:async()=>{},onPhotonAssertOwned:async()=>{},onPhotonCheckpoint:async()=>{},onPhotonFailure:async()=>{},
      onPhotonUsefulClientDebt:debt,onPhotonIntakePlacement:async()=>({kind:"cloud",bindingId:"controlled-current-binding"})} });
  let closeFails = true;
  const failure = new Error("controlled useful close failed");
  controls[1]!.client.close.mockImplementation(async () => { if (closeFails) throw failure; });
  try {
    await runtime.initialize();
    const adapter = runtime.getProviderAdapter(); if (!(adapter instanceof PhotonChatAdapter)) throw new Error("normal Photon adapter unavailable");
    expect(() => adapter.client).toThrow("useful-operation owner");
    expect(allocate).toHaveBeenCalledTimes(1); expect(controls[0]!.client.close).toHaveBeenCalledTimes(1);
    const body = Buffer.from("actual controlled saved attachment bytes");
    const info = {guid:"saved-file",totalBytes:body.length,fileName:"saved.txt",mimeType:"text/plain",isHidden:false,isSticker:false};
    const raw = photonMessage("saved-message",controls[0]!.chat.guid); Object.assign(raw,{paperclipIsGroup:false}); Object.assign(raw.content,{attachments:[info]});
    const message = adapter.parseMessage(raw), attachment = message.attachments[0]; if (!attachment) throw new Error("normal attachment absent");
    const source = {threadId:message.threadId,messageId:message.id,message};
    const descriptor = runtime.attachmentRecoveryDescriptor(attachment,source); if (!descriptor) throw new Error("normal durable locator absent");
    const saved = JSON.parse(JSON.stringify(descriptor));
    const recovered = runtime.rehydrateAttachment(saved,{threadId:message.threadId,messageId:message.id});
    if (!recovered?.fetchData) throw new Error("normal replay download absent");
    for (const control of controls.slice(1)) {
      control.client.messages.get.mockResolvedValue(raw);
      control.client.attachments.downloadStream.mockImplementation(() => photonStream([{type:"header",info},{type:"primaryChunk",data:body}]));
    }
    expect(runtime.rehydrateAttachment(saved,{threadId:message.threadId,messageId:"foreign-message"})).toBeNull();
    await expect(recovered.fetchData()).resolves.toEqual(body);
    expect(debt).toHaveBeenCalledTimes(1); expect(controls[1]!.client.attachments.downloadStream).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledTimes(2);
    await expect(recovered.fetchData()).rejects.toBe(failure);
    expect(allocate).toHaveBeenCalledTimes(2); expect(controls[1]!.client.attachments.downloadStream).toHaveBeenCalledTimes(1);
    closeFails = false;
    await expect(recovered.fetchData()).resolves.toEqual(body);
    expect(allocate).toHaveBeenCalledTimes(3); expect(controls[2]!.client.attachments.downloadStream).toHaveBeenCalledTimes(1);
    expect(controls[2]!.client.close).toHaveBeenCalledTimes(1);
  } finally {
    closeFails = false;
    try { await runtime.shutdown(); } finally { vi.restoreAllMocks(); }
  }
});


it("sender close receipt failure keeps the actual normal SDK Runtime retired until its durable completion callback retries", async () => {
  // Real Chat4.39/Runtime/registry lifecycle. Only the final persistence callback
  // has a controlled lost-reply fault; this is not real SQL or physical proof.
  const adapters: PhotonChatAdapter[] = [];
  vi.spyOn(PhotonChatAdapter.prototype, "initialize").mockImplementation(async function(this: PhotonChatAdapter) { adapters.push(this); });
  vi.spyOn(PhotonReceiver.prototype, "start").mockImplementation(() => undefined);
  vi.spyOn(PhotonReceiver.prototype, "close").mockResolvedValue(undefined);
  const registry = createChatSdkRuntime(), lostReply = new Error("controlled sender receipt commit reply lost");
  let callbacks = 0, allowReply = false;
  const runtime = await registry.replaceEndpoint({ companyId: "company", endpointId: "sender-receipt", logger: "silent", persistence: memoryPersistence(),
    providerConfig: { provider: "imessage-photon", userName: "Agent", intakeAfter: 0,
      credentials: { allocation: "dedicated", projectId: "project", projectSecret: "controlled-project-secret", lineId: "line", phoneNumber: "+15555550100" } },
    callbacks: { onMessage: async () => {}, onPhotonEvent: async () => {}, onPhotonAssertOwned: async () => {}, onPhotonCheckpoint: async () => {}, onPhotonFailure: async () => {},
      onPhotonSenderRuntimeClosed: async () => { callbacks++; if (!allowReply) throw lostReply; } } });
  try {
    await runtime.initialize(); const adapter = adapters[0]; if (!adapter) throw new Error("normal Photon adapter absent");
    const close = vi.spyOn(adapter.client, "close");
    await expect(registry.removeEndpoint("sender-receipt")).rejects.toBe(lostReply);
    expect(callbacks).toBe(1); expect(close).toHaveBeenCalledTimes(1);
    expect(registry.hasUnsettledLifecycle()).toBe(true); expect(registry.get("sender-receipt")).toBeNull();
    await expect(runtime.initialize()).rejects.toThrow("retired");
    allowReply = true;
    await expect(registry.removeEndpoint("sender-receipt")).resolves.toBe(true);
    expect(callbacks).toBe(2); expect(close).toHaveBeenCalledTimes(1);
    expect(registry.hasUnsettledLifecycle()).toBe(false);
  } finally { allowReply = true; try { await registry.shutdown(); } finally { vi.restoreAllMocks(); } }
});
