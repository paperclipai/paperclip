import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  shouldEnablePrivateHostnameGuard,
} from "../app.ts";

describe("chat worker startup wiring", () => {
  it("keeps receiver and voice inventory out of periodic chat maintenance", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const maintenance = source;
    expect(source).not.toContain("chatPublicationTimer");
    expect(source).not.toContain("createChatReconciliationCoordinator");
    expect(source).toContain("chatChannels.registerGitHubWebhookRecoveryWork(deliveryWork,");
    expect(maintenance).not.toContain("chatChannels.reconcileProviderRuntimes()");
    expect(maintenance).not.toContain("chatChannels.voice.reconcile()");
    expect(maintenance).not.toContain("enqueueSafeNativeChatProgress");
    expect(source).toContain("nativeChatProgressWork(db).register(deliveryWork,");
    expect(source).toContain("chatInboundWakeNoticeWork(chatChannels).register(deliveryWork,");
    expect(source).toContain("chatChannels.registerReceiverWork(deliveryWork,");
    expect(source).toContain("chatChannels.registerTeamsConsentExpiryWork(deliveryWork,");
    const teams = readFileSync(new URL("../services/chat-channels/microsoft-teams/file-delivery.ts", import.meta.url), "utf8");
    expect(source).toContain("chatChannels.registerTeamsAttemptRecoveryWork(deliveryWork,");
    expect(teams).not.toContain("scheduleTeamsFileMaintenance");
    expect(teams).not.toContain("selectDistinct");
    const chat = readFileSync(new URL("../services/chat-channels.ts", import.meta.url), "utf8");
    expect(chat).not.toContain("scheduleTeamsFileMaintenance");
    const publicationMaintenance = chat.slice(chat.indexOf("async function processPublicationMaintenance("),
      chat.indexOf("async function schedulePendingPublications("));
    expect(publicationMaintenance).not.toContain("await enqueueInboundWakeupPublications(");
    expect(publicationMaintenance).not.toContain("await enqueueFailedChatRetryPublications(");
    expect(publicationMaintenance).not.toContain("reconcileTerminalConfirmationActions(");
    expect(source).toContain("chatChannels.registerInteractionContinuationWork(deliveryWork,");
    expect(source).toContain("chatChannels.registerGitHubAcknowledgementWork(deliveryWork,");
    expect(chat).not.toContain("scheduleGitHubMaintenance");
    expect(source).toContain("registerGitHubReviewProjectionWork(db, deliveryWork,");
    expect(source).not.toContain("chatChannels.processPublicationMaintenance()");
    expect(source).toContain("chatChannels.registerGitHubTerminalResponseWork(deliveryWork,");
    expect(source).toContain("chatChannels.registerGitHubReviewCheckWork(deliveryWork,");
    expect(source).toContain("chatChannels.registerTerminalConfirmationWork(deliveryWork,");
    expect(source).toContain("chatFailedRetryNoticeWork(chatChannels).register(deliveryWork,");
  });

  it("separates live voice recovery from the remaining periodic maintenance", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain("chatChannels.voice.registerRecoveryWork(deliveryWork,");
    expect(source).toContain("chatChannels.voice.registerReplyWork(deliveryWork,");
    expect(source).toContain("chatChannels.voice.inbound.registerCleanupWork(deliveryWork,");
    expect(source).toContain("chatChannels.voice.inbound.registerRetentionWork(deliveryWork,");
    expect(source).toContain("chatChannels.voice.registerReportWork(deliveryWork,");
    expect(source).not.toContain("reconcileVoiceSessions");
    expect(source).not.toContain("chatChannels.voice.reconcile()");
  });

  it("wires GitHub recovery into its independent lane", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "chatChannels.registerGitHubWebhookRecoveryWork(deliveryWork,",
    );
    const service = readFileSync(
      new URL("../services/chat-channels.ts", import.meta.url),
      "utf8",
    );
    const ordinary = service.slice(
      service.indexOf("async function processPendingDeliveries("),
      service.indexOf("async function listResources("),
    );
    expect(ordinary).not.toContain("processFailedGitHubWebhookDeliveries()");
  });

  it("wires bounded publication refill to commit workers and isolates periodic maintenance", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    expect(source).toContain("registerChatDeliveryWork(deliveryWork, chatChannels,");
    expect(source).toContain("registerChatActionWork(deliveryWork, chatChannels,");
    const maintenance = source;
    expect(maintenance).not.toContain("chatChannels.processPublicationMaintenance()");
    expect(maintenance).not.toContain("chatChannels.schedulePendingPublications()");
    expect(maintenance).not.toContain("chatChannels.processPendingPublications()");
    const workers = readFileSync(new URL("../services/chat-delivery-work.ts", import.meta.url), "utf8");
    expect(workers).toContain("run: service.scheduleQueuedPublications");
    // The service integration tests hold real publication workers while this
    // scheduled method returns; app shutdown must also join those workers.
    expect(source).toContain("await chatChannels.shutdown()");
    expect(source).not.toContain("chatChannels.processPendingSlackSessionSyncs()");
    expect(source).not.toContain("chatChannels.processPendingChatMaintenance()");
    const service = readFileSync(new URL("../services/chat-channels.ts", import.meta.url), "utf8");
    const actionMaintenance = service.slice(service.indexOf("async function processPendingChatMaintenance("),
      service.indexOf("async function processPendingDeliveries("));
    expect(actionMaintenance).not.toContain("processFailedChatRunRetries(");
    expect(actionMaintenance).not.toContain("processPendingProviderEffects(");
    expect(actionMaintenance).not.toContain("processPendingGitHubWebhookIngress(");
  });


});

describe("shouldEnablePrivateHostnameGuard", () => {
  it("enables the hostname guard for local_trusted private deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
      }),
    ).toBe(true);
  });

  it("does not enable the hostname guard for local_trusted public deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "local_trusted",
        deploymentExposure: "public",
      }),
    ).toBe(false);
  });

  it("enables the hostname guard for authenticated private deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }),
    ).toBe(true);
  });

  it("does not enable the hostname guard for authenticated public deployments", () => {
    expect(
      shouldEnablePrivateHostnameGuard({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      }),
    ).toBe(false);
  });
});
