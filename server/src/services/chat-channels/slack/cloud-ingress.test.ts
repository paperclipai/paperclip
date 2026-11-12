import { HttpError } from "../../../errors.js";
import type { Db } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { createSlackCloudEventIngress, dispatchSlackCloudEvent, registerSlackCloudEventIngress } from "./cloud-ingress.js";
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

it.each([404, 422])("current ingress keeps credential failure %s as unacknowledged attention before callback admission", async status => {
  const endpoint = { id: "00000000-0000-4000-8000-000000000001", companyId: "company", publicId: "public", connectionId: "connection",
    provider: "slack", status: "active", providerAccountId: "TTEST", setup: { slackCloudEvents: {
      version: 1, bindingId: "binding", runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST" } } };
  const db = { select: () => {
    let joined = false;
    const query = { from: () => query, where: () => query, innerJoin: () => { joined = true; return query; },
      limit: async () => joined ? [{ endpoint, connection: { enabled: true, status: "active" } }] : [endpoint] };
    return query;
  } } as unknown as Db;
  const handleWebhook = vi.fn(async () => new Response());
  const withCredentialMutationLease: Parameters<typeof createSlackCloudEventIngress>[1]["withCredentialMutationLease"] =
    async (_endpoint, work) => work({ assertOwned: async () => {} } as Parameters<typeof work>[0]);
  const unregister = createSlackCloudEventIngress(db, { withCredentialMutationLease, runtimeGeneration: () => 1, handleWebhook,
    resolveCredentials: async () => { throw new HttpError(status, "synthetic credential failure"); } });
  try {
    await expect(dispatchSlackCloudEvent(db, { id: "receipt", provider: "slack", event: "event_callback", installationId: "binding",
      bindingIds: ["binding"], createdAt: new Date().toISOString(), payload: { slackEvent: {
        endpointId: endpoint.id, companyId: endpoint.companyId, publicId: endpoint.publicId,
        connectionId: endpoint.connectionId, runtimeGeneration: 1 } } }))
      .rejects.toMatchObject({ code: "signing_credential_unavailable", disposition: "attention" });
    expect(handleWebhook).not.toHaveBeenCalled();
  } finally { unregister(); }
});
