import { describe, expect, it, vi } from "vitest";
import { chatActions, chatEndpoints, chatPublications, toolConnections, type Db } from "@paperclipai/db";
import { createSlackFormPublicationStage } from "../services/chat-channels/slack/form-publication.js";

const fixture = vi.hoisted(() => ({ interactions: [] as unknown[] }));
vi.mock("../services/issue-thread-interactions.js", () => ({
  issueThreadInteractionService: () => ({ listForIssue: async () => fixture.interactions }),
}));
const binding = { version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint", connectionId: "connection",
  publicId: "p".repeat(43), runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST",
  eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) };
const { credentialFingerprint: _fingerprint, eventBindingId, ...identity } = binding;
const enrollment = { ...identity, bindingId: eventBindingId };
const scheduledIntent = { version: 1, id: "intent", active: true, subject: "actor", instanceId: "instance",
  companyId: "company", endpointId: "endpoint", connectionId: "connection", publicId: binding.publicId,
  runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", attempts: 0, nextAttemptAt: "2030-01-01T00:00:00Z" };
const confirmedSetup = { runtimeGeneration: 1, slackCloudInstanceId: "instance", slackCloudSubject: "actor",
  slackCloudEvents: { version: 1, runtimeGeneration: 1, bindingId: eventBindingId, teamId: "TTEST", appId: "ATEST" } };
function currentOwner() {
  return { id: "owner", status: "issued", payload: { enrollment, binding, subject: "actor", environment: "test" },
    result: { phase: "enrolled", nextAttemptAt: null as string | null, desiredActive: true } };
}
function inputs(setup: Record<string, unknown>, owners: unknown[] = []) {
  const endpoint: typeof chatEndpoints.$inferSelect = {
    id: "endpoint", companyId: "company", connectionId: "connection", provider: "slack",
    setup: { step: "provider_setup", ...setup }, status: "active", publicId: binding.publicId, providerAccountId: "TTEST",
    assignedAgentId: "agent", sponsorUserId: "actor", publicationMode: "automatic", externalExecutionPolicy: "restricted",
    deploymentMode: "direct", providerAccountLabel: null, botExternalId: null, botUsername: null, botDisplayName: null,
    botAvatarUrl: null, communicationInstructions: "", executionDefaults: null, allowDirectMessages: true,
    requireAtMention: false, allowGroupChats: false, allowUnlinkedPeople: false, concurrencyPolicy: "queue",
    capabilities: { threads: true, directMessages: true, nativeStreaming: true, messageEdits: true, messageDeletes: true,
      reactions: true, files: true, cards: true, actions: true, modals: true, slashCommands: true,
      ephemeralMessages: true, proactiveDirectMessages: false },
    healthMessage: null, lastEventAt: null, lastPublicationAt: null, lastError: null, activatedAt: null, archivedAt: null,
    createdAt: new Date(0), updatedAt: new Date(0),
  };
  const publication = { id: "publication", conversationId: "conversation", companyId: endpoint.companyId,
    endpointId: endpoint.id, issueId: "issue", payload: { interactionId: "interaction" } } as typeof chatPublications.$inferSelect;
  const connection = { id: "connection", companyId: "company", status: "active", enabled: true };
  fixture.interactions = [{ id: "interaction", companyId: "company", issueId: "issue", status: "pending", kind: "ask_user_questions",
    payload: { version: 1, title: "Choose", questions: ["first", "second"].map(id => ({ id, prompt: "Choose",
      selectionMode: "single", options: [{ id: "a", label: "A" }] })) } }];
  const select = vi.fn((columns?: unknown) => ({ from: (table: unknown) => ({ where: () => ({ limit: async () =>
    table === chatEndpoints ? [endpoint] : table === toolConnections ? [connection]
      : table === chatActions && columns ? [{ id: "open" }] : owners,
  }) }) }));
  const db = { select } as unknown as Db;
  return { endpoint, publication, connection, select, prepare: createSlackFormPublicationStage(db) };
}
describe("Slack form publication enrollment readiness", () => {
  it("waits for the first managed enrollment before a forms binding exists", async () => {
    const f = inputs({ slackCloudIntent: scheduledIntent, runtimeGeneration: 1 });
    await expect(f.prepare(f.endpoint, f.publication)).resolves.toEqual({ kind: "wait", reason: "form_publication_enrollment_pending", retryAfterMs: 2000 });
    expect(f.select).toHaveBeenCalledTimes(3);
  });
  it("preserves local Slack publication when no managed Cloud enrollment is configured", async () => {
    const f = inputs({ step: "ready" });
    await expect(f.prepare(f.endpoint, f.publication)).resolves.toBeNull();
    expect(f.select).not.toHaveBeenCalled();
  });
  it("does not wait for unsupported or no longer pending interactions", async () => {
    const f = inputs({ slackCloudIntent: scheduledIntent, runtimeGeneration: 1 });
    fixture.interactions = [];
    await expect(f.prepare(f.endpoint, f.publication)).resolves.toBeNull();
    expect(f.select).not.toHaveBeenCalled();
  });
  it("retains fail-closed parsing for a present malformed binding", async () => {
    const f = inputs({ ...confirmedSetup, slackCloudForms: { version: 1 } });
    await expect(f.prepare(f.endpoint, f.publication)).rejects.toMatchObject({ code: "invalid_form_receipt" });
  });
});
