import { slackFormRetirementReceipt } from "./ack-retirement-receipt.js";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { CAPABILITIES } from "../provider-catalog.js";
import { verifyCloudControlAssertion, CLOUD_CONTROL_AUDIENCE, CLOUD_CONTROL_JWS_TYPE } from "../../cloud-runtime-identity.js";
import type { IdleCapabilities, VerifiedIdleCapabilities } from "../../idle-incoming-wake-capability.js";
import { parseSlackFormBinding } from "./cloud-forms.js";
import { slackConfiguredBindingsFingerprint } from "./configured-coverage.js";
import { readSlackIdleIncomingProof, projectSlackIdleIncomingRows, type SlackIdleEndpoint, type SlackIdleConnection } from "./idle-incoming.js";
import type { SlackFormHistoryRow } from "./form-idle-history.js";
const binding = parseSlackFormBinding({ version: 1, instanceId: "instance", companyId: "11111111-1111-4111-8111-111111111111", endpointId: "22222222-2222-4222-8222-222222222222", publicId: "p".repeat(43), connectionId: "33333333-3333-4333-8333-333333333333", runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) });
function verifiedPartial(): VerifiedIdleCapabilities {
  const key = generateKeyPairSync("ed25519"), kid = "slack-idle-unit", now = Math.floor(Date.now() / 1000), generation = "c".repeat(64);
  const caps: IdleCapabilities = { incomingWake: { version: 1, ownerId: randomUUID(), generation, routes: ["slack-broker-events-v1"],
    slackBroker: { version: 1, instanceId: binding.instanceId, generation, bindingsFingerprint: slackConfiguredBindingsFingerprint([binding]), entries: [{ binding, lanes: ["events", "forms", "modal_close", "modal_submit"] }] } } };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = encode({ alg: "EdDSA", typ: CLOUD_CONTROL_JWS_TYPE, kid }) + "." + encode({ v: 1, iss: "paperclip-cloud", aud: CLOUD_CONTROL_AUDIENCE,
    sub: binding.instanceId, action: "task-drain:read", requestId: randomUUID(), iat: now, exp: now + 60, idleCapabilities: caps });
  const claims = verifyCloudControlAssertion({ compactJws: body + "." + sign(null, Buffer.from(body), key.privateKey).toString("base64url"), expectedAction: "task-drain:read",
    env: { PAPERCLIP_CLOUD_STACK_ID: binding.instanceId, PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...key.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "EdDSA" }] }) } });
  if (!claims.idleCapabilities) throw new Error("Actual signed idle capability absent");
  return claims.idleCapabilities as VerifiedIdleCapabilities;
}
function rows() {
  const { credentialFingerprint: _, eventBindingId, ...base } = binding, enrollment = { ...base, bindingId: eventBindingId };
  const endpoint: SlackIdleEndpoint = { id: binding.endpointId, companyId: binding.companyId, connectionId: binding.connectionId, publicId: binding.publicId,
    provider: "slack", status: "active", capabilities: CAPABILITIES.slack, setup: { step: "complete", runtimeGeneration: 1, slackCloudInstanceId: binding.instanceId,
      slackCloudSubject: "actor", slackCloudForms: binding, slackCloudEvents: { runtimeGeneration: 1, bindingId: binding.eventBindingId, teamId: binding.teamId, appId: binding.appId } } };
  const connection: SlackIdleConnection = { id: binding.connectionId, companyId: binding.companyId, status: "active", enabled: true, transport: "chat_sdk", connectionPurpose: "channel" };
  const owner: SlackFormHistoryRow = { id: "44444444-4444-4444-8444-444444444444", companyId: binding.companyId, endpointId: binding.endpointId, kind: "slack_form_owner", principalId: null, conversationId: null,
    status: "issued", providerActionId: "slack-form-owner:" + "d".repeat(64), payload: { enrollment, binding, subject: "actor", environment: "test" }, result: { phase: "enrolled", nextAttemptAt: null } };
  return { endpoints: [{ endpoint, connection }], actions: [owner] };
}
it("absent signed Slack proof performs zero query and budget operations", async () => {
  let calls = 0;
  const tx: Pick<Db, "select"> = { select: () => { calls++; throw new Error("No absent-feature query permitted"); } };
  expect(await readSlackIdleIncomingProof(tx, { receiverBound: true, beforeRead: async () => { calls++; }, remaining: () => { calls++; return 1; }, registeredOptions: () => false })).toBeUndefined();
  expect(calls).toBe(0);
  expect(await readSlackIdleIncomingProof(tx, { capabilities: verifiedPartial(), identity: { instanceId: binding.instanceId, environment: "test" }, receiverBound: false,
    beforeRead: async () => { calls++; }, remaining: () => { calls++; return 1; }, registeredOptions: () => false })).toBeUndefined();
  expect(calls).toBe(0);
});
it("genuinely signed forms-events-only coverage keeps default commands and general actions blocked", () => {
  const result = projectSlackIdleIncomingRows({ ...rows(), capabilities: verifiedPartial(), identity: { instanceId: binding.instanceId, environment: "test" }, registeredOptions: () => false });
  expect(result).toEqual({ endpointIds: [], connectionIds: [], completedActionIds: [] });
});
it("foreign company and duplicate current owners never become current Slack completion authority", () => {
  const current = rows(), capabilities = verifiedPartial(), common = { capabilities, identity: { instanceId: binding.instanceId, environment: "test" as const }, registeredOptions: () => false };
  expect(projectSlackIdleIncomingRows({ ...current, ...common, endpoints: [{ ...current.endpoints[0]!, connection: { ...current.endpoints[0]!.connection, companyId: "foreign" } }] })).toBeUndefined();
  expect(projectSlackIdleIncomingRows({ ...current, ...common, actions: Array.from({ length: 1001 }, () => current.actions[0]!) })).toBeUndefined();
});

it("retained completed receipts exceed one history page without enlarging the current endpoint cap", () => {
  const current=rows(),receipt=slackFormRetirementReceipt(binding,"test","actor");
  const history:SlackFormHistoryRow[]=Array.from({length:1005},()=>({id:randomUUID(),companyId:binding.companyId,endpointId:binding.endpointId,
    kind:"slack_form_grant",principalId:null,conversationId:null,status:"cancelled",providerActionId:"slack-form-grant:"+randomUUID(),
    payload:{binding,subject:"actor",environment:"test"},result:{phase:"transferred",nextAttemptAt:null,
      retirement:{version:1,binding,instanceId:binding.instanceId,environment:"test",subject:"actor",receiptDigest:receipt.receiptId,receipt}}}));
  const common={capabilities:verifiedPartial(),identity:{instanceId:binding.instanceId,environment:"test" as const},registeredOptions:()=>false};
  const result=projectSlackIdleIncomingRows({...current,...common,actions:[...current.actions,...history]});
  expect(result?.completedActionIds).toEqual(history.map(row=>row.id).sort());
  expect(projectSlackIdleIncomingRows({...current,...common,endpoints:Array.from({length:1001},()=>current.endpoints[0]!)})).toBeUndefined();
});
