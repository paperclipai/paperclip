import type { Db } from "@paperclipai/db";
import { afterEach, expect, it, vi } from "vitest";
import { githubConnectionEventService } from "../../github-connection-events.js";
import type { PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { registerSlackCloudEventIngress } from "./cloud-ingress.js";
import { SlackCloudReceiptError, type SlackCloudEvent } from "./cloud-event.js";

afterEach(() => vi.unstubAllEnvs());
function fixture(handler: (event: SlackCloudEvent) => Promise<void>) {
  vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", "");
  let reads = 0;
  const db = { select: () => {
    const rows = [[], [], [{ companyId: "company" }]][reads++ % 3]!;
    const query = { from: () => query, innerJoin: () => query, where: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve) };
    return query;
  } } as unknown as Db;
  const event: SlackCloudEvent = { id: "slack-receipt", provider: "slack", event: "event_callback", installationId: "binding", bindingIds: ["binding"],
    createdAt: new Date().toISOString(), payload: {} };
  const connector = { leaseEvents: vi.fn(async () => ({ leaseId: "lease", events: [event] })),
    acknowledgeEvents: vi.fn(async () => 1), eventWakeVersion: () => 1 as const };
  const unregister = registerSlackCloudEventIngress(db, handler);
  const service = githubConnectionEventService(db, { connector: connector as unknown as PaperclipCloudConnector });
  return { service, connector, unregister, event };
}

it("actual connection-event owner routes Slack and retries a lost ACK through the registered owner", async () => {
  const handler = vi.fn(async () => {}), f = fixture(handler);
  try {
    f.connector.acknowledgeEvents.mockRejectedValueOnce(new Error("ack response lost"));
    await expect(f.service.pollOnce({ forDelivery: true })).rejects.toThrow("ack response lost");
    expect((await f.service.pollOnce({ forDelivery: true })).processed).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(f.connector.leaseEvents).toHaveBeenCalledWith({ subject: "github-bot-events", companyId: "company", eventWakeVersion: 1 });
    expect(f.connector.acknowledgeEvents).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryIds: [f.event.id] }));
  } finally { f.unregister(); }
});

it.each(["retry", "attention", "invalid"] as const)("actual owner distinguishes %s receipt failure before ACK", async disposition => {
  const f = fixture(async () => { throw new SlackCloudReceiptError("synthetic_code", disposition); });
  try {
    const result = await f.service.pollOnce({ forDelivery: true });
    expect(result.failed).toBe(disposition === "invalid" ? 0 : 1);
    expect(f.connector.acknowledgeEvents).toHaveBeenCalledTimes(disposition === "invalid" ? 1 : 0);
  } finally { f.unregister(); }
});
