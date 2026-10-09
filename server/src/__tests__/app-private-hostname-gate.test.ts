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
        reconcileProviderRuntimes: async () => undefined,
        projectRunMilestones: async () => 0,
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

  it("wires periodic publication reconciliation to bounded scheduled refill rather than awaiting provider sends", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const flush = source.slice(
      source.indexOf("const flushChatPublications ="),
      source.indexOf("const flushChatPublications =") + 600,
    );
    expect(flush).toContain("await chatChannels.schedulePendingPublications()");
    expect(flush).not.toContain("chatChannels.processPendingPublications()");
    expect(
      flush.slice(0, flush.indexOf("const chatReconciliation")),
    ).not.toContain("await enqueueChatRunMilestones");
    // The service integration tests hold real publication workers while this
    // scheduled method returns; app shutdown must also join those workers.
    expect(source).toContain("await chatChannels.shutdown()");
  });

  it.each([false, true])(
    "isolates a blocked milestone projector and joins its completion (rejects: %s)",
    async (rejects) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const failure = new Error("milestone projection failed");
      const projectRunMilestones = vi
        .fn(async () => 0)
        .mockImplementationOnce(async () => {
          await held;
          if (rejects) throw failure;
          return 1;
        });
      const flushPublications = vi.fn(async () => undefined);
      const onError = vi.fn();
      const coordinator = createChatReconciliationCoordinator({
        projectRunMilestones,
        reconcileProviderRuntimes: async () => undefined,
        processPendingDeliveries: async () => undefined,
        flushPublications,
        processPendingSlackFileUploadReceipts: async () => undefined,
        processPendingSlackSessionSyncs: async () => undefined,
        onError,
      });
      try {
        coordinator.reconcile();
        await vi.waitFor(() => {
          expect(projectRunMilestones).toHaveBeenCalledTimes(1);
          expect(flushPublications).toHaveBeenCalledTimes(1);
        });
        // A newly committed final/question must dispatch even while a different
        // issue's projection is blocked. Repeated signals leave one dirty retry.
        coordinator.notifyPublications();
        coordinator.notifyPublications();
        await vi.waitFor(() =>
          expect(flushPublications).toHaveBeenCalledTimes(2),
        );
        expect(projectRunMilestones).toHaveBeenCalledTimes(1);
        let drained = false;
        const draining = coordinator.drain().then(() => {
          drained = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(drained).toBe(false);
        release();
        await draining;
        expect(projectRunMilestones).toHaveBeenCalledTimes(2);
        expect(onError).toHaveBeenCalledTimes(rejects ? 1 : 0);
        if (rejects)
          expect(onError).toHaveBeenCalledWith("run milestones", failure);
        const completedCounts = [
          projectRunMilestones.mock.calls.length,
          flushPublications.mock.calls.length,
        ];
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect([
          projectRunMilestones.mock.calls.length,
          flushPublications.mock.calls.length,
        ]).toEqual(completedCounts);
      } finally {
        release();
        coordinator.stop();
        await coordinator.drain();
      }
    },
  );

  it("joins a blocked milestone projector at shutdown without starting dirty follow-ups", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const projectRunMilestones = vi.fn(async () => {
      await held;
      return 1;
    });
    const flushPublications = vi.fn(async () => undefined);
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones,
      flushPublications,
      reconcileProviderRuntimes: async () => undefined,
      processPendingDeliveries: async () => undefined,
      processPendingSlackFileUploadReceipts: async () => undefined,
      processPendingSlackSessionSyncs: async () => undefined,
      onError: vi.fn(),
    });
    try {
      coordinator.reconcile();
      await vi.waitFor(() => {
        expect(projectRunMilestones).toHaveBeenCalledOnce();
        expect(flushPublications).toHaveBeenCalledOnce();
      });
      coordinator.notifyPublications();
      coordinator.stop();
      let drained = false;
      const draining = coordinator.drain().then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      release();
      await draining;
      expect(projectRunMilestones).toHaveBeenCalledOnce();
      expect(flushPublications).toHaveBeenCalledOnce();
    } finally {
      release();
      coordinator.stop();
      await coordinator.drain();
    }
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
    const reconcileProviderRuntimes = vi.fn(async () => undefined);
    const processPendingDeliveries = vi.fn(async () => deliveryReleased);
    const flushPublications = vi.fn(async () => undefined);
    const processPendingSlackFileUploadReceipts = vi.fn(async () => undefined);
    const processPendingSlackSessionSyncs = vi.fn(
      async () => slackStatusReleased,
    );
    const onError = vi.fn();
    const coordinator = createChatReconciliationCoordinator({
      projectRunMilestones: async () => 0,
      reconcileProviderRuntimes,
      processPendingDeliveries,
      flushPublications,
      processPendingSlackFileUploadReceipts,
      processPendingSlackSessionSyncs,
      onError,
    });

    coordinator.reconcile();
    await vi.waitFor(() => {
      expect(reconcileProviderRuntimes).toHaveBeenCalledTimes(1);
      expect(processPendingDeliveries).toHaveBeenCalledTimes(1);
      expect(flushPublications).toHaveBeenCalledTimes(1);
      expect(processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(1);
      expect(processPendingSlackSessionSyncs).toHaveBeenCalledTimes(1);
    });
    coordinator.reconcile();
    await vi.waitFor(() => {
      expect(reconcileProviderRuntimes).toHaveBeenCalledTimes(2);
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
      const reconcileProviderRuntimes = vi.fn(async () => undefined);
      const processPendingDeliveries = vi.fn(async () => undefined);
      const flushPublications = vi.fn(async () => undefined);
      const processPendingSlackSessionSyncs = vi.fn(async () => undefined);
      const onError = vi.fn();
      const coordinator = createChatReconciliationCoordinator({
        projectRunMilestones: async () => 0,
        reconcileProviderRuntimes,
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
          expect(reconcileProviderRuntimes).toHaveBeenCalledTimes(2);
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
