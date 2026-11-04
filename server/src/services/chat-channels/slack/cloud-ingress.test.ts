import type { Db } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { dispatchSlackCloudEvent, registerSlackCloudEventIngress } from "./cloud-ingress.js";
import type { SlackCloudEvent } from "./cloud-event.js";

it("missing or failed runtime owner retains the leased event; retired owner cleanup cannot remove its replacement", async () => {
  const db = {} as Db;
  const event: SlackCloudEvent = { id: "receipt", provider: "slack", event: "event_callback", installationId: "binding",
    bindingIds: ["binding"], createdAt: "2099-01-01T00:00:00Z", payload: {} };
  await expect(dispatchSlackCloudEvent(db, event)).rejects.toThrow("not ready");
  const stopped = vi.fn(async () => { throw new Error("admission stopped"); });
  const unregisterOld = registerSlackCloudEventIngress(db, stopped);
  await expect(dispatchSlackCloudEvent(db, event)).rejects.toThrow("admission stopped");
  const replacement = vi.fn(async () => {});
  const unregisterNew = registerSlackCloudEventIngress(db, replacement);
  unregisterOld();
  await dispatchSlackCloudEvent(db, event);
  expect(replacement).toHaveBeenCalledWith(event);
  unregisterNew();
  await expect(dispatchSlackCloudEvent(db, event)).rejects.toThrow("not ready");
});
