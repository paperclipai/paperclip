import { createTeamsAdapter } from "@chat-adapter/teams";
import { describe, expect, it } from "vitest";
import {
  bindTeamsPersonalRecipient,
  deriveTeamsPersonalRecipient,
  parseTeamsPersonalRecipient,
  parseTeamsPersonalRecipientBinding,
  type TeamsPersonalRecipientAdmission,
  type TeamsPersonalRecipientBindingScope,
} from "./chat-teams-personal-recipient.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const botAppId = "22222222-2222-4222-8222-222222222222";
const companyId = "33333333-3333-4333-8333-333333333333";
const endpointId = "44444444-4444-4444-8444-444444444444";
const aadObjectId = "55555555-5555-4555-8555-555555555555";
const deliveryId = "66666666-6666-4666-8666-666666666666";
const principalId = "77777777-7777-4777-8777-777777777777";
const conversationId = "88888888-8888-4888-8888-888888888888";
const providerUserId = "29:synthetic-personal-user";
const providerConversationId = "a:synthetic-personal-conversation";
const canonicalThread = (id: string) =>
  `teams:${Buffer.from(id).toString("base64url")}`;
const adapter = createTeamsAdapter({
  appId: botAppId,
  appPassword: "synthetic-unused-secret",
  appTenantId: tenantId,
  appType: "SingleTenant",
});

function fixture() {
  const raw = {
    type: "message",
    channelId: "msteams",
    id: "activity-1",
    timestamp: "2026-09-09T00:00:00.000Z",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: providerUserId, aadObjectId, name: "Synthetic person" },
    recipient: { id: `28:${botAppId}` },
    conversation: {
      id: providerConversationId,
      conversationType: "personal",
      tenantId,
    },
    channelData: { tenant: { id: tenantId } },
    text: "SYNTHETIC-PRIVATE-MESSAGE",
    token: "SYNTHETIC-PRIVATE-TOKEN",
  };
  // Exercise the installed adapter's actual normalization, not a fabricated
  // Message. Parsing does not authenticate this synthetic activity or use HTTP.
  const message = adapter.parseMessage(raw);
  const admission: TeamsPersonalRecipientAdmission = {
    companyId,
    endpointId,
    runtimeGeneration: 7,
    credentialFingerprint: "a".repeat(64),
    tenantId,
    botAppId,
    providerEventId: `${canonicalThread(providerConversationId)}:${raw.id}`,
    threadId: message.threadId,
    isDirectMessage: true,
  };
  const binding: TeamsPersonalRecipientBindingScope = {
    admission,
    deliveryId,
    principalId,
    externalPrincipalId: aadObjectId,
    conversationId,
    conversationGeneration: 3,
  };
  return { raw, message, admission, binding };
}

describe("Teams durable personal-recipient evidence", () => {
  it("retains the exact normalized personal recipient without token, text, name, or route", () => {
    const { message, admission } = fixture();
    // The pinned SDK omits :personal for this ID. Only the authenticated raw
    // activity's explicit conversationType is evidence of personal scope.
    expect(message.threadId.endsWith(":personal")).toBe(false);
    const proof = deriveTeamsPersonalRecipient(message, admission);
    expect(proof).toEqual({
      schema: "paperclip.teams.personal-recipient.v1",
      companyId,
      endpointId,
      runtimeGeneration: 7,
      credentialFingerprint: "a".repeat(64),
      tenantId,
      botAppId,
      aadObjectId,
      providerUserId,
      providerConversationId,
      providerActivityId: "activity-1",
      providerEventId: admission.providerEventId,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(JSON.stringify(proof)).not.toMatch(
      /SYNTHETIC-PRIVATE|trafficmanager|Synthetic person/,
    );
    expect(
      parseTeamsPersonalRecipient(JSON.parse(JSON.stringify(proof)), admission),
    ).toEqual(proof);
  });

  it("binds a persisted proof to exact delivery, current principal, and conversation generation", () => {
    const { message, admission, binding } = fixture();
    const proof = deriveTeamsPersonalRecipient(message, admission);
    const bound = bindTeamsPersonalRecipient(
      JSON.parse(JSON.stringify(proof)),
      binding,
    );
    expect(bound).toEqual({
      schema: "paperclip.teams.personal-recipient-binding.v1",
      recipient: proof,
      deliveryId,
      principalId,
      conversationId,
      conversationGeneration: 3,
    });
    expect(
      parseTeamsPersonalRecipientBinding(
        JSON.parse(JSON.stringify(bound)),
        binding,
      ),
    ).toEqual(bound);
    expect(Object.isFrozen(bound)).toBe(true);
  });

  it("supports an explicitly personal non-legacy-prefix conversation and route-free durable matching", () => {
    const { raw, admission } = fixture();
    raw.conversation.id = "19:explicit-personal@unq.gbl.spaces";
    const message = adapter.parseMessage(raw);
    const expected = {
      ...admission,
      threadId: canonicalThread(raw.conversation.id),
      providerEventId: `${canonicalThread(raw.conversation.id)}:${raw.id}`,
    };
    expect(message.threadId.endsWith(":personal")).toBe(true);
    expect(deriveTeamsPersonalRecipient(message, expected)).toMatchObject({
      providerConversationId: raw.conversation.id,
    });
  });

  it.each([
    [
      "missing explicit personal type",
      (raw: Record<string, any>): void => {
        delete raw.conversation.conversationType;
      },
    ],
    [
      "group chat",
      (raw: Record<string, any>): void => {
        raw.conversation.conversationType = "groupChat";
      },
    ],
    [
      "channel",
      (raw: Record<string, any>): void => {
        raw.conversation.conversationType = "channel";
      },
    ],
    [
      "contradictory group flag",
      (raw: Record<string, any>): void => {
        raw.conversation.isGroup = true;
      },
    ],
    [
      "team metadata",
      (raw: Record<string, any>): void => {
        raw.channelData.team = { id: "team-1" };
      },
    ],
    [
      "channel metadata",
      (raw: Record<string, any>): void => {
        raw.channelData.channel = { id: "channel-1" };
      },
    ],
    [
      "foreign tenant",
      (raw: Record<string, any>): void => {
        raw.conversation.tenantId = companyId;
      },
    ],
    [
      "contradictory tenant",
      (raw: Record<string, any>): void => {
        raw.channelData.tenant.id = companyId;
      },
    ],
    [
      "missing both tenants",
      (raw: Record<string, any>): void => {
        delete raw.conversation.tenantId;
        delete raw.channelData.tenant;
      },
    ],
    [
      "wrong recipient",
      (raw: Record<string, any>): void => {
        raw.recipient.id = `28:${companyId}`;
      },
    ],
    [
      "targeted bot",
      (raw: Record<string, any>): void => {
        raw.recipient.isTargeted = true;
      },
    ],
    [
      "missing AAD",
      (raw: Record<string, any>): void => {
        delete raw.from.aadObjectId;
      },
    ],
    [
      "missing BF user",
      (raw: Record<string, any>): void => {
        delete raw.from.id;
      },
    ],
    [
      "bot sender",
      (raw: Record<string, any>): void => {
        raw.from.role = "bot";
      },
    ],
    [
      "conversation message suffix",
      (raw: Record<string, any>): void => {
        raw.conversation.id += ";messageid=other";
      },
    ],
    [
      "wrong activity kind",
      (raw: Record<string, any>): void => {
        raw.type = "invoke";
      },
    ],
    [
      "wrong channel",
      (raw: Record<string, any>): void => {
        raw.channelId = "webchat";
      },
    ],
  ] as const)(
    "rejects %s without inferring from SDK isDM or cached AAD",
    (_label, mutate) => {
      const { raw, admission } = fixture();
      mutate(raw);
      expect(
        deriveTeamsPersonalRecipient(adapter.parseMessage(raw), admission),
      ).toBeNull();
    },
  );

  it.each([
    { companyId: deliveryId },
    { endpointId: deliveryId },
    { runtimeGeneration: 8 },
    { credentialFingerprint: "b".repeat(64) },
    { tenantId: companyId },
    { botAppId: companyId },
    { providerEventId: "foreign-event" },
    { threadId: canonicalThread("foreign-conversation") },
    { isDirectMessage: false },
  ])("rejects independently changed admission scope %j", (patch) => {
    const { message, admission } = fixture();
    const proof = deriveTeamsPersonalRecipient(message, admission);
    expect(proof).not.toBeNull();
    expect(
      parseTeamsPersonalRecipient(proof, { ...admission, ...patch }),
    ).toBeNull();
  });

  it.each([
    { deliveryId: companyId },
    { principalId: companyId },
    { externalPrincipalId: companyId },
    { conversationId: companyId },
    { conversationGeneration: 4 },
  ])("rejects an independently changed durable binding %j", (patch) => {
    const { message, admission, binding } = fixture();
    const bound = bindTeamsPersonalRecipient(
      deriveTeamsPersonalRecipient(message, admission),
      binding,
    );
    expect(bound).not.toBeNull();
    expect(
      parseTeamsPersonalRecipientBinding(bound, { ...binding, ...patch }),
    ).toBeNull();
  });

  it("refuses malformed, unknown, unbounded, and legacy proof rather than fabricating identity", () => {
    const { message, admission, binding } = fixture();
    const proof = deriveTeamsPersonalRecipient(message, admission) as Record<
      string,
      unknown
    >;
    expect(proof).not.toBeNull();
    for (const invalid of [
      null,
      {},
      { ...proof, schema: "future" },
      { ...proof, token: "secret" },
      { ...proof, providerUserId: "x".repeat(1025) },
      { ...proof, providerUserId: "bad\nuser" },
      { ...proof, runtimeGeneration: -1 },
      { ...proof, runtimeGeneration: 1.5 },
      { ...proof, aadObjectId: "not-a-uuid" },
      { ...proof, credentialFingerprint: "not-a-digest" },
    ])
      expect(parseTeamsPersonalRecipient(invalid, admission)).toBeNull();
    expect(
      bindTeamsPersonalRecipient(proof, {
        ...binding,
        externalPrincipalId: providerUserId,
      }),
    ).toBeNull();
    expect(
      deriveTeamsPersonalRecipient(
        {
          ...message,
          raw: {},
          author: { ...message.author, userId: aadObjectId },
        },
        admission,
      ),
    ).toBeNull();
    expect(
      deriveTeamsPersonalRecipient({ ...message, id: "other" }, admission),
    ).toBeNull();
    expect(
      deriveTeamsPersonalRecipient(
        { ...message, author: { ...message.author, userId: "other" } },
        admission,
      ),
    ).toBeNull();
    const bound = bindTeamsPersonalRecipient(proof, binding);
    expect(bound).not.toBeNull();
    for (const invalid of [
      null,
      {},
      { ...bound, schema: "future" },
      { ...bound, token: "secret" },
      { ...bound, recipient: { ...proof, token: "secret" } },
      { ...bound, conversationGeneration: 0 },
    ]) {
      expect(parseTeamsPersonalRecipientBinding(invalid, binding)).toBeNull();
    }
  });
});
