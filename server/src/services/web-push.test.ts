import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the web-push module before any imports that use it
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

import webPush from "web-push";
import { webPushService, type PushSubscriptionData } from "./web-push.js";

const mockSendNotification = vi.mocked(webPush.sendNotification);

function makeDb(rows: SRow[] = []) {
  let store = [...rows];

  return {
    _store: () => store,
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => Promise.resolve(),
      }),
    }),
    delete: () => ({
      where: () => {
        // simple delete: remove matching endpoint from store
        store = store.filter(() => false); // simplified for pruning test
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: () => ({
        orderBy: () => Promise.resolve(store),
      }),
    }),
  } as unknown as Parameters<typeof webPushService>[0];
}

type SRow = { endpoint: string; p256dh: string; auth: string; id: string; deviceLabel: string; createdAt: Date };

const SUB: PushSubscriptionData = {
  endpoint: "https://push.example.com/test",
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtwe",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe("webPushService.sendToSubscription", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PAPERCLIP_VAPID_PUBLIC_KEY = "BDummyPublicKey1234567890abcdefghijklmnop";
    process.env.PAPERCLIP_VAPID_PRIVATE_KEY = "DummyPrivateKey1234567890abcdef";
  });

  it("prunes subscription on 410 Gone", async () => {
    const deletedEndpoints: string[] = [];
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
      delete: () => ({
        where: (_cond: unknown) => {
          deletedEndpoints.push(SUB.endpoint);
          return Promise.resolve();
        },
      }),
      select: () => ({ from: () => ({ orderBy: () => Promise.resolve([]) }) }),
    } as unknown as Parameters<typeof webPushService>[0];

    const err = Object.assign(new Error("Gone"), { statusCode: 410 });
    mockSendNotification.mockRejectedValueOnce(err);

    const svc = webPushService(db);
    const result = await svc.sendToSubscription(SUB, { title: "Test" });

    expect(result).toEqual({ sent: false, pruned: true });
    expect(deletedEndpoints).toContain(SUB.endpoint);
  });

  it("prunes subscription on 404 Not Found", async () => {
    const deletedEndpoints: string[] = [];
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
      delete: () => ({
        where: (_cond: unknown) => {
          deletedEndpoints.push(SUB.endpoint);
          return Promise.resolve();
        },
      }),
      select: () => ({ from: () => ({ orderBy: () => Promise.resolve([]) }) }),
    } as unknown as Parameters<typeof webPushService>[0];

    const err = Object.assign(new Error("Not Found"), { statusCode: 404 });
    mockSendNotification.mockRejectedValueOnce(err);

    const svc = webPushService(db);
    const result = await svc.sendToSubscription(SUB, { title: "Test" });

    expect(result).toEqual({ sent: false, pruned: true });
    expect(deletedEndpoints).toContain(SUB.endpoint);
  });

  it("returns sent=true on success", async () => {
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
      delete: () => ({ where: () => Promise.resolve() }),
      select: () => ({ from: () => ({ orderBy: () => Promise.resolve([]) }) }),
    } as unknown as Parameters<typeof webPushService>[0];

    mockSendNotification.mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} } as unknown as Awaited<ReturnType<typeof webPush.sendNotification>>);

    const svc = webPushService(db);
    const result = await svc.sendToSubscription(SUB, { title: "Test" });

    expect(result).toEqual({ sent: true, pruned: false });
  });

  it("does not prune on non-404/410 errors", async () => {
    const deletedEndpoints: string[] = [];
    const db = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
      delete: () => ({
        where: (_cond: unknown) => {
          deletedEndpoints.push(SUB.endpoint);
          return Promise.resolve();
        },
      }),
      select: () => ({ from: () => ({ orderBy: () => Promise.resolve([]) }) }),
    } as unknown as Parameters<typeof webPushService>[0];

    const err = Object.assign(new Error("Server Error"), { statusCode: 500 });
    mockSendNotification.mockRejectedValueOnce(err);

    const svc = webPushService(db);
    const result = await svc.sendToSubscription(SUB, { title: "Test" });

    expect(result).toEqual({ sent: false, pruned: false });
    expect(deletedEndpoints).toHaveLength(0);
  });
});
