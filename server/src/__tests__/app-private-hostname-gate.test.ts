import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createChatReconciliationCoordinator,
  shouldEnablePrivateHostnameGuard,
} from "../app.ts";

describe("createChatReconciliationCoordinator", () => {
  it.each([false, true])(
    "keeps later inbound sweeps independent of GitHub recovery and joins shutdown (rejects: %s)",
    async (rejects) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error("GitHub recovery unavailable");
      const processFailedGitHubWebhookDeliveries = vi.fn(async () => {
        await held;
        if (rejects) throw failure;
      });
      const processPendingDeliveries = vi.fn(async () => undefined);
      const flushPublications = vi.fn(async () => undefined);
      const onError = vi.fn();
      const input = {
        processFailedGitHubWebhookDeliveries,
        processPendingDeliveries,
        flushPublications,
        processPendingSlackFileUploadReceipts: async () => undefined,
        processPendingSlackSessionSyncs: async () => undefined,
        onError,
      };
      const coordinator = createChatReconciliationCoordinator(input);
      let draining: Promise<void> | undefined;
      try {
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processFailedGitHubWebhookDeliveries).toHaveBeenCalledOnce();
          expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
        });
        // A second sweep must admit work arriving AFTER the first sweep while
        // remote GitHub recovery remains held. Same-sweep parallelism is not enough.
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processPendingDeliveries).toHaveBeenCalledTimes(2);
          expect(flushPublications).toHaveBeenCalledTimes(2);
        });
        expect(processFailedGitHubWebhookDeliveries).toHaveBeenCalledOnce();
        coordinator.stop();
        let drained = false;
        draining = coordinator.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        coordinator.reconcile();
        release();
        await draining;
        expect(drained).toBe(true);
        expect(processFailedGitHubWebhookDeliveries).toHaveBeenCalledOnce();
        expect(processPendingDeliveries).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
        if (rejects)
          expect(onError).toHaveBeenCalledWith(
            "GitHub webhook recovery",
            failure,
          );
      } finally {
        release();
        coordinator.stop();
        await (draining ?? coordinator.drain());
      }
    },
  );

  it("keeps receiver and voice inventory out of periodic chat maintenance", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const maintenance = source.slice(source.indexOf("const chatReconciliation ="), source.indexOf("const unsubscribeChatPublicationSignals"));
    expect(maintenance).not.toContain("chatChannels.reconcileProviderRuntimes()");
    expect(maintenance).not.toContain("chatChannels.voice.");
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
    const github = readFileSync(new URL("../services/chat-channels/github/maintenance.ts", import.meta.url), "utf8");
    expect(github).not.toContain("githubResponseCommentService(db, fetchImpl).processPending()");
    expect(github).not.toContain("githubResponseCommentService(db, fetchImpl).processTerminalResponses()");
    expect(source).toContain("chatChannels.registerGitHubTerminalResponseWork(deliveryWork,");
    expect(source).toContain("chatChannels.registerGitHubReviewCheckWork(deliveryWork,");
    expect(github).not.toContain("githubReviewCheckService(db, fetchImpl).processPending()");
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
      "chatChannels.processFailedGitHubWebhookDeliveries()",
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
    const maintenance = source.slice(
      source.indexOf("const reconcileChatPublicationMaintenance ="),
      source.indexOf("const chatReconciliation ="),
    );
    expect(maintenance).toContain("chatChannels.processPublicationMaintenance()");
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

  it("keeps slow optional recovery from suppressing later publication sweeps", async () => {
    let releaseDelivery!: () => void;
    let releaseSlackStatus!: () => void;
    const deliveryReleased = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const slackStatusReleased = new Promise<void>((resolve) => {
      releaseSlackStatus = resolve;
    });
    const processPendingDeliveries = vi.fn(async () => deliveryReleased);
    const flushPublications = vi.fn(async () => undefined);
    const processPendingSlackFileUploadReceipts = vi.fn(async () => undefined);
    const processPendingSlackSessionSyncs = vi.fn(
      async () => slackStatusReleased,
    );
    const onError = vi.fn();
    const coordinator = createChatReconciliationCoordinator({
      processPendingDeliveries,
      flushPublications,
      processPendingSlackFileUploadReceipts,
      processPendingSlackSessionSyncs,
      onError,
    });

    coordinator.reconcile();
    await vi.waitFor(() => {
      expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
      expect(flushPublications).toHaveBeenCalledTimes(1);
      expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(1);
      expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(1);
    });
    coordinator.reconcile();
    await vi.waitFor(() => {
      expect(flushPublications).toHaveBeenCalledTimes(2);
      expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(2);
    });
    expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
    expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(1);

    releaseDelivery();
    releaseSlackStatus();
    await coordinator.drain();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "joins the independent Slack file receipt lane at shutdown (rejects: %s)",
    async (rejects) => {
      let releaseReceipt!: () => void;
      const receiptReleased = new Promise<void>((resolve) => {
        releaseReceipt = resolve;
      });
      const lookupError = new Error("receipt lookup failed");
      const processPendingSlackFileUploadReceipts = vi
        .fn(async () => undefined)
        .mockImplementationOnce(async () => {
          await receiptReleased;
          if (rejects) throw lookupError;
        });
      const processPendingDeliveries = vi.fn(async () => undefined);
      const flushPublications = vi.fn(async () => undefined);
      const processPendingSlackSessionSyncs = vi.fn(async () => undefined);
      const onError = vi.fn();
      const coordinator = createChatReconciliationCoordinator({
        processPendingDeliveries,
        flushPublications,
        processPendingSlackFileUploadReceipts,
        processPendingSlackSessionSyncs,
        onError,
      });
      let draining: Promise<void> | undefined;
      try {
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(
            1,
          );
          expect(flushPublications).toHaveBeenCalledTimes(1);
        });
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(processPendingDeliveries).toHaveBeenCalledTimes(2);
          expect(flushPublications).toHaveBeenCalledTimes(2);
          expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(2);
        });
        expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(1);

        let drained = false;
        draining = coordinator.drain().then(() => {
          drained = true;
        });
        // Flush the promise queue, not a wall-clock delay: the held receipt
        // must still be part of shutdown's joined work after other lanes end.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        expect(onError).not.toHaveBeenCalled();

        releaseReceipt();
        await draining;
        expect(drained).toBe(true);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
        if (rejects) {
          expect(onError).toHaveBeenCalledWith(
            "Slack file receipts",
            lookupError,
          );
        }

        // A completed or failed lookup releases only its own single-flight
        // slot; the next ordinary reconciliation can recover another receipt.
        coordinator.reconcile();
        await coordinator.drain();
        expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
      } finally {
        releaseReceipt();
        await draining;
        await coordinator.drain();
      }
    },
  );
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
