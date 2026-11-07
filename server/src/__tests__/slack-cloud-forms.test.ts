import { slackFormConnectorIdentity, selectSlackFormRetainedConsumer } from "../services/chat-channels/slack/cloud-consumer.js";
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackFormSubmissionEvidence, withSlackFormSubmissionEvidence, assertSlackFormTerminalAck, lookupSlackFormDelivery, parseSlackFormOperation, type SlackFormBinding, type SlackFormView, type SlackFormOperation } from "../services/chat-channels/slack/cloud-forms.js";

import { parseSlackFormProofAcceptance, prepareSlackFormProofAcceptance, projectSlackFormRetainedOwner, type SlackFormTerminalIntent, type SlackFormRetainedRow, openSlackFormSubmissionIntent, prepareSlackFormSubmissionIntent } from "../services/chat-channels/slack/form-session.js";
import { createLocalEncryptedCipher } from "../secrets/local-encrypted-provider.js";

afterEach(() => { vi.unstubAllEnvs(); });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const acceptedAt = "2099-01-01T00:00:00.000Z", secret = "0123456789abcdef0123456789abcdef";
  const binding: SlackFormBinding = { version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint", publicId: "a".repeat(43), connectionId: "connection",
    runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", eventBindingId: `slack-event:${hash("event")}`, credentialFingerprint: hash("credential") };
  const raw = Buffer.from(new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", trigger_id: "trigger", user: { id: "UTEST" }, team: { id: "TTEST" }, api_app_id: "ATEST" }) }).toString());
  const rawBody = raw.toString("base64"), timestamp = String(Date.parse(acceptedAt) / 1000);
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
  const id = hash("operation");
  const operation: SlackFormOperation = { version: 1, binding, grantId: hash("grant"), id, externalId: `pc-form-${id}`, deliveryId: `slack_form_${id}`,
    requestDigest: hash(JSON.stringify([rawBody, timestamp, signature])), triggerDigest: hash("trigger"), userId: "UTEST", acceptedAt,
    triggerDeadline: "2099-01-01T00:00:03.000Z", phase: "reserved", view: null, closed: null, acknowledgement: null, rejection: null };
  const packet = { version: 1, instanceId: "instance", environment: "test", operation, acceptedAt, rawBody, timestamp, signature };
  const event = { id: operation.deliveryId, provider: "slack", event: "form_open", installationId: `slack-form-open:${id}`, bindingIds: [`slack-form-open:${id}`], createdAt: acceptedAt, payload: { slackFormOpen: packet } };
  const current = { kind: "current" as const, binding, instanceId: "instance", environment: "test", signingSecret: secret };
  const lookup = vi.fn(async () => ({ version: 1, instanceId: "instance", environment: "test", operation }));
  function close(view: SlackFormView): NonNullable<SlackFormOperation["closed"]> {
    const body = Buffer.from(new URLSearchParams({ payload: JSON.stringify({ type: "view_closed", api_app_id: "ATEST", team: { id: "TTEST" },
      user: { id: "UTEST" }, view: { id: view.id, hash: view.hash, external_id: view.externalId, app_id: "ATEST" } }) }).toString());
    const rawBody = body.toString("base64"), signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`;
    return { kind: "closed", view, acceptedAt, requestDigest: hash(JSON.stringify([rawBody, timestamp, signature])), evidence: {
      version: 1, kind: "close", submitReceiptId: null, instanceId: "instance", environment: "test", operationId: id, binding, acceptedAt, rawBody, timestamp, signature } };
  }
  return { operation, packet, event, current, lookup, close, now: Date.parse(acceptedAt) + 3500 };
}

describe("Slack form original evidence and on-demand receipt", () => {
  it("pending receipt makes one lookup and retains retry responsibility without SDK or ACK", async () => {
    const f = fixture();
    await expect(lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now)).rejects.toMatchObject({ code: "form_receipt_pending", disposition: "retry" });
    expect(f.lookup).toHaveBeenCalledExactlyOnceWith({ binding: f.current.binding, operationId: f.operation.id, deliveryId: f.event.id });
    expect(f.packet.operation.phase).toBe("reserved");
  });
  it("delayed confirmed receipt preserves original acceptance and current generation", async () => {
    const f = fixture(), view = { id: "VTEST", hash: "hash1", externalId: f.operation.externalId };
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, phase: "confirmed", view } });
    const result = await lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now);
    expect(result.operation.view).toEqual(view); expect(result.operation.acceptedAt).toBe(f.event.createdAt);
    expect(result.originalPayload.trigger_id).toBe("trigger");
  });
  it.each(["companyId", "endpointId", "connectionId", "credentialFingerprint", "instanceId"] as const)("foreign %s cannot reach lookup", async key => {
    const f = fixture();
    await expect(lookupSlackFormDelivery(f.event, { ...f.current, binding: { ...f.current.binding, [key]: "foreign" } }, f.lookup, f.now)).rejects.toMatchObject({ disposition: "attention" });
    expect(f.lookup).not.toHaveBeenCalled();
  });
  it("original signature failure cannot reset freshness or reach lookup", async () => {
    const f = fixture(); f.packet.signature = `v0=${"0".repeat(64)}`;
    await expect(lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now)).rejects.toMatchObject({ code: "form_original_authentication_failed" });
    expect(f.lookup).not.toHaveBeenCalled();
  });
  it("lookup successor identity cannot overwrite the original queue operation", async () => {
    const f = fixture();
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, requestDigest: hash("successor") } });
    await expect(lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now)).rejects.toMatchObject({ code: "form_lookup_identity_changed", disposition: "attention" });
    expect(f.packet.operation.requestDigest).not.toBe(hash("successor"));
  });
  it("confirmed but already closed is surfaced as closed custody, never an update instruction", async () => {
    const f = fixture(), view = { id: "VTEST", hash: "hash1", externalId: f.operation.externalId };
    const closed = f.close(view);
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, phase: "confirmed", view, closed } });
    expect((await lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now)).operation.closed).toEqual(closed);
  });
  it("ambiguous provider outcome remains explicit, never becomes fabricated confirmation", async () => {
    const f = fixture();
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, phase: "ambiguous" } });
    const result = await lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now);
    expect(result.operation.phase).toBe("ambiguous"); expect(result.operation.view).toBeNull();
  });
  it("active or merely closed views cannot ACK before durable owner transfer", () => {
    const f = fixture(), view = { id: "VTEST", hash: "hash1", externalId: f.operation.externalId };
    expect(() => assertSlackFormTerminalAck({ ...f.operation, phase: "confirmed", view }, "11111111-1111-1111-1111-111111111111")).toThrow("form_view_active");
    expect(() => assertSlackFormTerminalAck({ ...f.operation, phase: "confirmed", view, closed: f.close(view) }, "11111111-1111-1111-1111-111111111111")).toThrow();
    expect(() => assertSlackFormTerminalAck({ ...f.operation, phase: "acknowledged", view, closed: f.close(view),
      acknowledgement: { appReceiptId: "11111111-1111-1111-1111-111111111111", acceptedAt: f.operation.acceptedAt } }, "11111111-1111-1111-1111-111111111111")).not.toThrow();
  });
  it("retained custody accepts only sealed verified close settlement after local credentials removed", async () => {
    const f = fixture(), view = { id: "VTEST", hash: "hash1", externalId: f.operation.externalId };
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, phase: "confirmed", view, closed: f.close(view) } });
    const result = await lookupSlackFormDelivery(f.event, { kind: "retained", binding: f.current.binding, instanceId: "instance", environment: "test" }, f.lookup, f.now);
    expect(result.authority).toBe("retained"); expect(result.operation.closed?.view.id).toBe("VTEST");
  });
  it("retained unresolved operation cannot authorize a new useful form", async () => {
    const f = fixture(), view = { id: "VTEST", hash: "hash1", externalId: f.operation.externalId };
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, phase: "confirmed", view } });
    await expect(lookupSlackFormDelivery(f.event, { kind: "retained", binding: f.current.binding, instanceId: "instance", environment: "test" }, f.lookup, f.now))
      .rejects.toMatchObject({ code: "form_retained_resource_unresolved", disposition: "attention" });
  });
  it("definite no-effect is identity-bound and exchanged trigger is never a no-effect proof", async () => {
    const f = fixture(), observation = { source: "provider_response", status: 200, body: { ok: false, error: "expired_trigger_id" } };
    const responseDigest = hash(JSON.stringify([f.operation.id, "expired_trigger_id", observation]));
    const rejection: NonNullable<SlackFormOperation["rejection"]> = { code: "expired_trigger_id", observedAt: f.operation.acceptedAt, responseDigest,
      evidence: { version: 1, kind: "rejection", instanceId: "instance", environment: "test", operationId: f.operation.id, binding: f.current.binding,
        observedAt: f.operation.acceptedAt, code: "expired_trigger_id", responseDigest, observation } };
    f.lookup.mockResolvedValueOnce({ version: 1, instanceId: "instance", environment: "test", operation: { ...f.operation, phase: "rejected", rejection } });
    expect((await lookupSlackFormDelivery(f.event, f.current, f.lookup, f.now)).operation.rejection?.responseDigest).toBe(responseDigest);
    expect(() => parseSlackFormOperation({ ...f.operation, phase: "rejected", rejection: { ...rejection, code: "exchanged_trigger_id" } })).toThrow();
  });
  it("closed parser refuses unknown fields and conflicting view identity", () => {
    const f = fixture();
    expect(() => parseSlackFormOperation({ ...f.operation, token: "forbidden" })).toThrow();
    expect(() => parseSlackFormOperation({ ...f.operation, phase: "confirmed", view: { id: "VTEST", hash: "h", externalId: "foreign" } })).toThrow();
  });
});

function submissionRequest(endpointId = "endpoint") {
  const f = fixture(), payload = { type: "view_submission", api_app_id: "ATEST", team: { id: "TTEST" }, user: { id: "UTEST" },
    view: { id: "VTEST", hash: "useful-hash", external_id: f.operation.externalId, app_id: "ATEST", callback_id: "opaque-submit", state: { values: { secret: "private-answer-for-terminal-cipher-proof" } } } };
  const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), timestamp = "4070908800";
  const signature = `v0=${createHmac("sha256", f.current.signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
  const request = new Request("https://paperclip.invalid/slack", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body: raw });
  return { f, request, raw, endpointId };
}

describe("Slack form submission leaf evidence, without SDK/domain authorization claims", () => {
  it("preserves original SDK request and scopes concurrent immutable evidence", async () => {
    const a = submissionRequest("a"), b = submissionRequest("b");
    const result = await Promise.all([a, b].map(async f => withSlackFormSubmissionEvidence(f.request, f.endpointId, true, async () => {
      await Promise.resolve(); const original = slackFormSubmissionEvidence()!;
      expect(Object.isFrozen(original)).toBe(true); expect(original.endpointId).toBe(f.endpointId);
      expect(Buffer.from(original.rawBody, "base64").toString()).toBe(f.raw);
      expect(await f.request.text()).toBe(f.raw); return original.endpointId;
    })));
    expect(result).toEqual(["a", "b"]); expect(slackFormSubmissionEvidence()).toBeUndefined();
  });
  it("absent feature does not read request; failed normal callback discards context", async () => {
    const f = submissionRequest(), error = new Error("controlled normal authentication refusal");
    await withSlackFormSubmissionEvidence(f.request, "endpoint", false, async () => { expect(slackFormSubmissionEvidence()).toBeUndefined(); });
    expect(f.request.bodyUsed).toBe(false);
    await expect(withSlackFormSubmissionEvidence(f.request, "endpoint", true, async () => { throw error; })).rejects.toBe(error);
    expect(slackFormSubmissionEvidence()).toBeUndefined();
  });
  it("bounded capture cannot run the callback after excessive input", async () => {
    const request = new Request("https://paperclip.invalid/slack", { method: "POST", body: "x".repeat(1048577) }), work = vi.fn(async () => {});
    await expect(withSlackFormSubmissionEvidence(request, "endpoint", true, work)).rejects.toMatchObject({ code: "form_submission_too_large" });
    expect(work).not.toHaveBeenCalled(); expect(slackFormSubmissionEvidence()).toBeUndefined();
  });
  it("existing local cipher protects original evidence and refuses wrong key or foreign custody", async () => {
    const f = submissionRequest(); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "ab".repeat(32));
    const cipher = createLocalEncryptedCipher("read");
    await withSlackFormSubmissionEvidence(f.request, "endpoint", true, async () => {
      const original = slackFormSubmissionEvidence()!;
      const intent = prepareSlackFormSubmissionIntent({ version: 1, binding: f.f.current.binding, operationId: f.f.operation.id, deliveryId: f.f.event.id,
        userId: "UTEST", grantId: f.f.operation.grantId, publicationId: "publication", interactionId: "interaction", appReceiptId: "11111111-1111-4111-8111-111111111111" },
        { id: "VTEST", hash: "useful-hash", externalId: f.f.operation.externalId }, "22222222-2222-4222-8222-222222222222", original, cipher);
      expect(JSON.stringify(intent)).not.toContain("private-answer-for-terminal-cipher-proof");
      expect(JSON.stringify(intent)).not.toContain(original.rawBody);
      expect(openSlackFormSubmissionIntent(intent, cipher).rawBody).toBe(original.rawBody);
      expect(() => openSlackFormSubmissionIntent({ ...intent, binding: { ...intent.binding, companyId: "foreign" } }, cipher)).toThrow("form_submission_cipher_binding_changed");
      vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "cd".repeat(32));
      const wrong = createLocalEncryptedCipher("read");
      expect(() => openSlackFormSubmissionIntent(intent, wrong)).toThrow("form_submission_cipher_unavailable");
    });
  });
});

function closedProofFixture() {
  const f = fixture(), view = { id: "VTEST", hash: "hash1", externalId: f.operation.externalId }, appReceiptId = "11111111-1111-1111-1111-111111111111";
  const intent: SlackFormTerminalIntent = { version: 1, binding: f.current.binding, operationId: f.operation.id, deliveryId: f.operation.deliveryId,
    userId: f.operation.userId, grantId: f.operation.grantId, publicationId: "publication", interactionId: "interaction", appReceiptId, view,
    outcome: "closed", submitReceiptId: null, rejectionDigest: null, encryptedEvidence: null };
  const operation: SlackFormOperation = { ...f.operation, phase: "terminal_proven", view, closed: f.close(view),
    acknowledgement: { appReceiptId, acceptedAt: f.operation.acceptedAt } };
  const row: SlackFormRetainedRow = { id: appReceiptId, companyId: intent.binding.companyId, endpointId: intent.binding.endpointId, kind: "slack_form_session",
    providerActionId: `slack-form-session:${intent.operationId}`, status: "cancelled", payload: { binding: intent.binding, operationId: intent.operationId,
      userId: intent.userId, grantId: intent.grantId, publicationId: intent.publicationId, interactionId: intent.interactionId }, result: { phase: "closed", terminalIntent: intent } };
  return { f, intent, operation, row };
}
describe("Slack form two phase terminal acceptance, provider boundaries only", () => {
  it("accepts only actual terminal proof for the same durable App receipt without finalizing Cloud ACK", () => {
    const f = closedProofFixture(), before = structuredClone(f.operation);
    const accepted = prepareSlackFormProofAcceptance(f.intent, f.operation, "instance");
    expect(parseSlackFormProofAcceptance(accepted)).toEqual(accepted); expect(accepted.appReceiptId).toBe(f.row.id);
    expect(f.operation).toEqual(before); expect(f.operation.phase).toBe("terminal_proven");
  });
  it("pending, foreign instance, changed receipt and changed terminal intent cannot become proof accepted", () => {
    const f = closedProofFixture();
    expect(() => prepareSlackFormProofAcceptance(f.intent, { ...f.operation, phase: "confirmed", acknowledgement: null }, "instance")).toThrow();
    expect(() => prepareSlackFormProofAcceptance(f.intent, f.operation, "foreign")).toThrow();
    expect(() => prepareSlackFormProofAcceptance({ ...f.intent, appReceiptId: "22222222-2222-2222-2222-222222222222" }, f.operation, "instance")).toThrow();
    expect(() => prepareSlackFormProofAcceptance({ ...f.intent, view: { ...f.intent.view!, hash: "foreign" } }, f.operation, "instance")).toThrow();
  });
  it("phase parser refuses a proof without exact terminal evidence or acceptance", () => {
    const f = closedProofFixture();
    expect(() => parseSlackFormOperation({ ...f.operation, acknowledgement: null })).toThrow();
    expect(() => parseSlackFormOperation({ ...f.operation, closed: null })).toThrow();
    const accepted = prepareSlackFormProofAcceptance(f.intent, f.operation, "instance");
    expect(() => parseSlackFormProofAcceptance({ ...accepted, outcome: "invented" })).toThrow();
    expect(() => parseSlackFormProofAcceptance({ ...accepted, providerToken: "forbidden" })).toThrow();
  });
  it("retained accepted history supplies a stable event identity without making completed history polling work", () => {
    const f = closedProofFixture();
    const pending = projectSlackFormRetainedOwner(f.row, "instance"); expect(pending?.requiresDelivery).toBe(true);
    const accepted = prepareSlackFormProofAcceptance(f.intent, f.operation, "instance");
    const retained = projectSlackFormRetainedOwner({ ...f.row, result: { ...f.row.result, cloudProofAcceptance: accepted } }, "instance");
    expect(retained).toMatchObject({ subject: "github-bot-events", companyId: "company", requiresDelivery: false });
    expect(retained?.binding).toEqual(f.intent.binding);
  });
  it("foreign malformed history is isolated before parsing and changed current receipt is attention", () => {
    const f = closedProofFixture();
    expect(projectSlackFormRetainedOwner({ ...f.row, payload: { binding: { instanceId: "foreign", malformed: true } } }, "instance")).toBeNull();
    const accepted = prepareSlackFormProofAcceptance(f.intent, f.operation, "instance");
    expect(() => projectSlackFormRetainedOwner({ ...f.row, companyId: "foreign" }, "instance")).toThrow();
    expect(() => projectSlackFormRetainedOwner({ ...f.row, result: { ...f.row.result, cloudProofAcceptance: { ...accepted, appReceiptId: "22222222-2222-2222-2222-222222222222" } } }, "instance")).toThrow();
  });
  it("definite no effect proof requires the recorded digest and no view or closed input", () => {
    const f = closedProofFixture(), observation = { ok: false, error: "expired_trigger_id" }, responseDigest = hash(JSON.stringify([f.operation.id, "expired_trigger_id", observation]));
    const operation: SlackFormOperation = { ...f.operation, view: null, closed: null, rejection: { code: "expired_trigger_id", observedAt: f.operation.acceptedAt,
      responseDigest, evidence: { version: 1, kind: "rejection", instanceId: "instance", environment: "test", operationId: f.operation.id, binding: f.operation.binding,
        observedAt: f.operation.acceptedAt, code: "expired_trigger_id", responseDigest, observation } } };
    const intent: SlackFormTerminalIntent = { ...f.intent, outcome: "no_effect", view: null, rejectionDigest: responseDigest };
    expect(prepareSlackFormProofAcceptance(intent, operation, "instance").outcome).toBe("no_effect");
    expect(() => prepareSlackFormProofAcceptance({ ...intent, rejectionDigest: hash("foreign") }, operation, "instance")).toThrow();
  });
});

it("submitted proof accepts only the encrypted same submission and is idempotent without another encryption", () => {
  const f = submissionRequest(); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "ab".repeat(32));
  const cipher = createLocalEncryptedCipher("read"), encrypt = vi.spyOn(cipher, "encrypt"), base = closedProofFixture();
  const original = { endpointId: "endpoint", acceptedAt: f.f.operation.acceptedAt, rawBody: Buffer.from(f.raw).toString("base64"),
    timestamp: f.request.headers.get("x-slack-request-timestamp")!, signature: f.request.headers.get("x-slack-signature")! };
  const view = { id: "VTEST", hash: "useful-hash", externalId: f.f.operation.externalId }, submitReceiptId = "22222222-2222-4222-8222-222222222222";
  const intent = prepareSlackFormSubmissionIntent(base.intent, view, submitReceiptId, original, cipher);
  const operation: SlackFormOperation = { ...base.operation, view, closed: { kind: "submitted", view, acceptedAt: original.acceptedAt,
    requestDigest: hash(JSON.stringify([original.rawBody, original.timestamp, original.signature])), evidence: { version: 1, kind: "submission", submitReceiptId,
      instanceId: "instance", environment: "test", operationId: base.operation.id, binding: base.operation.binding, acceptedAt: original.acceptedAt,
      rawBody: original.rawBody, timestamp: original.timestamp, signature: original.signature } } };
  const accepted = prepareSlackFormProofAcceptance(intent, operation, "instance", cipher);
  expect(accepted.outcome).toBe("submitted"); expect(prepareSlackFormProofAcceptance(intent, operation, "instance", cipher)).toEqual(accepted);
  expect(encrypt).toHaveBeenCalledTimes(1);
  expect(() => prepareSlackFormProofAcceptance(intent, { ...operation, closed: { ...operation.closed!, requestDigest: hash("foreign") } }, "instance", cipher)).toThrow();
});


describe("retained form consumer identity", () => {
  it("old connector mocks and absent Cloud do not acquire form authority", () => {
    expect(slackFormConnectorIdentity(null)).toBeNull();
    expect(slackFormConnectorIdentity({ leaseEvents: vi.fn() })).toBeNull();
    expect(slackFormConnectorIdentity({ instanceIdentity: () => ({ instanceId: "instance", environment: "foreign" }) })).toBeNull();
    expect(slackFormConnectorIdentity({ instanceIdentity: () => { throw new Error("unsupported"); } })).toBeNull();
    expect(slackFormConnectorIdentity({ instanceIdentity: () => ({ instanceId: "instance", environment: "test" }) })).toEqual({ instanceId: "instance", environment: "test" });
  });
  it("malformed owned history cannot starve a valid proof-accepted ACK consumer", () => {
    const f = closedProofFixture(), accepted = prepareSlackFormProofAcceptance(f.intent, f.operation, "instance");
    const good = { ...f.row, payload: { ...f.row.payload, environment: "test" }, result: { ...f.row.result, cloudProofAcceptance: accepted } };
    const malformed = { ...f.row, id: "malformed", payload: { binding: { instanceId: "instance", malformed: true }, environment: "test" } };
    const result = selectSlackFormRetainedConsumer([malformed, good], { instanceId: "instance", environment: "test" });
    expect(result.attention).toEqual([{ actionId: "malformed", code: "form_retained_owner_invalid" }]);
    expect(result.owner).toMatchObject({ subject: "github-bot-events", companyId: "company", requiresDelivery: false });
    expect(result.owner?.binding).toEqual(f.intent.binding);
  });
  it("a foreign or wrong-environment row cannot supply terminal lease authority", () => {
    const f = closedProofFixture();
    const foreign = { ...f.row, payload: { binding: { instanceId: "foreign", malformed: true } } };
    expect(selectSlackFormRetainedConsumer([foreign], { instanceId: "instance", environment: "test" })).toEqual({ owner: null, attention: [] });
    const result = selectSlackFormRetainedConsumer([{ ...f.row, payload: { ...f.row.payload, environment: "production" } }], { instanceId: "instance", environment: "test" });
    expect(result.owner).toBeNull(); expect(result.attention).toHaveLength(1);
  });
  it("lost enrollment response retains public custody without inventing a credential binding", () => {
    const f = closedProofFixture(), { eventBindingId, credentialFingerprint: _, ...identity } = f.intent.binding;
    const row: SlackFormRetainedRow = { ...f.row, kind: "slack_form_owner", payload: { enrollment: { ...identity, bindingId: eventBindingId }, subject: "actor", environment: "test" }, result: { phase: "staged" } };
    const result = selectSlackFormRetainedConsumer([row], { instanceId: "instance", environment: "test" });
    expect(result.attention).toEqual([]);
    expect(result.owner).toEqual({ subject: "github-bot-events", companyId: "company", binding: null, requiresDelivery: true });
  });
});


it("retained session selection keeps unfinished GC custody but completed exact receipt history supplies no consumer", () => {
  const f = closedProofFixture(), proof = prepareSlackFormProofAcceptance(f.intent, f.operation, "instance");
  const receipt = { version: 1 as const, kind: "slack_form_finalized" as const, binding: f.intent.binding, environment: "test" as const,
    operationId: f.intent.operationId, deliveryId: f.intent.deliveryId, appReceiptId: f.row.id, grantId: f.intent.grantId,
    publicationId: f.intent.publicationId, interactionId: f.intent.interactionId, userId: f.intent.userId,
    viewDigest: hash(JSON.stringify([f.intent.view!.id, f.intent.view!.hash, f.intent.view!.externalId])),
    terminalDigest: proof.terminalDigest, outcome: "closed" as const, finalizedAt: f.operation.acceptedAt };
  const base = { ...f.row, payload: { ...f.row.payload, environment: "test" }, result: { ...f.row.result, cloudProofAcceptance: proof,
    formAck: { version: 1, phase: "transferred", leaseId: "exact-lease", deliveryId: receipt.deliveryId, receiptJws: "a.b.c", receipt }, nextAttemptAt: null } };
  const identity = { instanceId: "instance", environment: "test" as const };
  expect(selectSlackFormRetainedConsumer([base], identity)).toEqual({ owner: null, attention: [] });
  for (const phase of ["accepted", "gc_pending"]) {
    const pending = { ...base, result: { ...base.result, formAck: { ...base.result.formAck, phase }, nextAttemptAt: f.operation.acceptedAt } };
    expect(selectSlackFormRetainedConsumer([pending], identity).owner).toMatchObject({ companyId: f.row.companyId, subject: "github-bot-events", requiresDelivery: false });
  }
  const malformed = { ...base, result: { ...base.result, formAck: { ...base.result.formAck, receipt: { ...receipt, binding: { ...receipt.binding, companyId: "foreign" } } } } };
  const result = selectSlackFormRetainedConsumer([malformed], identity);
  expect(result.owner !== null || result.attention.length > 0).toBe(true);
  const stillDue = { ...base, result: { ...base.result, nextAttemptAt: f.operation.acceptedAt } };
  expect(selectSlackFormRetainedConsumer([stillDue], identity).owner).not.toBeNull();
});
