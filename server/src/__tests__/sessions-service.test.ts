import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PaperclipSessionDocument } from "@paperclipai/shared";
import { PAPERCLIP_SESSION_SCHEMA_VERSION } from "@paperclipai/shared";
import { HttpError } from "../errors.ts";
import {
  createSessionStateAdapter,
  evaluateCarSessionAdHocTrigger,
  evaluateSessionStateModelReadiness,
  listCarSessionAdHocTriggerFramework,
  parseSessionDocumentBody,
  parseSessionTransitionReceiptBody,
  sessionTransitionReceiptDocumentKey,
} from "../services/sessions.ts";

type FakeDocument = {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: string;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeSession(overrides: Partial<PaperclipSessionDocument> = {}): PaperclipSessionDocument {
  const companyId = overrides.companyId ?? randomUUID();
  const issueId = overrides.issueId ?? randomUUID();
  const state = overrides.state ?? "open";
  const now = "2026-05-18T19:00:00.000Z";
  return {
    schemaVersion: PAPERCLIP_SESSION_SCHEMA_VERSION,
    policyKey: "car-leadership-sessions",
    policyVersion: "2026-05-18",
    companyId,
    issueId,
    sessionType: "eod",
    state,
    stateRevision: 0,
    idempotencyKey: `session:${issueId}`,
    objective: "Turn one material CAR finding into an owner-bound next action.",
    source: {
      triggerClass: "eod_material_finding",
      source: "operator:test",
      collectedAt: now,
      snapshot: { issueIdentifier: "CAR-1095" },
    },
    participants: [
      {
        role: "CRO",
        agentId: randomUUID(),
        issueId: randomUUID(),
        status: "pending",
      },
    ],
    receipts: [],
    taskRoutes: [],
    reviews: [],
    eodFindings: [],
    health: [],
    lastTransition: {
      transitionId: randomUUID(),
      transition: "create",
      actor: { actorType: "service", actorId: "session-service", runId: randomUUID() },
      beforeState: state === "open" ? null : "open",
      afterState: state,
      at: now,
    },
    ...overrides,
  };
}

function createFakeStore(initial?: FakeDocument | FakeDocument[] | null) {
  const docs = new Map<string, FakeDocument>();
  const makeKey = (issueId: string, key: string) => `${issueId}:${key}`;
  const initialDocs = Array.isArray(initial) ? initial : initial ? [initial] : [];
  for (const doc of initialDocs) {
    docs.set(makeKey(doc.issueId, doc.key), doc);
  }

  return {
    get document() {
      return [...docs.values()].find((doc) => doc.key === "session") ?? null;
    },
    getDocument(issueId: string, key: string) {
      return docs.get(makeKey(issueId, key)) ?? null;
    },
    async getIssueDocumentByKey(issueId: string, key: string) {
      return docs.get(makeKey(issueId, key)) ?? null;
    },
    async upsertIssueDocument(input: {
      issueId: string;
      key: string;
      title?: string | null;
      format: string;
      body: string;
      baseRevisionId?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      expectedCompanyId?: string | null;
    }) {
      const now = new Date("2026-05-18T19:00:00.000Z");
      const existing = docs.get(makeKey(input.issueId, input.key)) ?? null;
      const created = !existing;
      const revisionId = randomUUID();
      const document = {
        id: existing?.id ?? randomUUID(),
        companyId: existing?.companyId ?? input.expectedCompanyId ?? randomUUID(),
        issueId: input.issueId,
        key: input.key,
        title: input.title ?? null,
        format: input.format,
        body: input.body,
        latestRevisionId: revisionId,
        latestRevisionNumber: (existing?.latestRevisionNumber ?? 0) + 1,
        createdByAgentId: existing?.createdByAgentId ?? input.createdByAgentId ?? null,
        createdByUserId: existing?.createdByUserId ?? input.createdByUserId ?? null,
        updatedByAgentId: input.createdByAgentId ?? null,
        updatedByUserId: input.createdByUserId ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      docs.set(makeKey(input.issueId, input.key), document);
      return { created, document };
    },
  };
}

function expectHttpError(error: unknown, status: number) {
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
}

describe("session document contract", () => {
  it("parses machine-readable session JSON and rejects generic document prose", () => {
    const session = makeSession();
    expect(parseSessionDocumentBody(JSON.stringify(session)).state).toBe("open");

    expect(() => parseSessionDocumentBody("we talked about CAR-1095")).toThrow(HttpError);
    try {
      parseSessionDocumentBody("we talked about CAR-1095");
    } catch (error) {
      expectHttpError(error, 422);
    }
  });

  it("requires revision and state compare-and-set before updating session state", async () => {
    const store = createFakeStore();
    const adapter = createSessionStateAdapter(store);
    const issueId = randomUUID();
    const companyId = randomUUID();
    const created = await adapter.write({
      issueId,
      companyId,
      nextState: makeSession({ companyId, issueId }),
      actorAgentId: randomUUID(),
    });

    expect(created.created).toBe(true);
    expect(created.before).toBeNull();
    expect(created.afterRevisionId).toBeTruthy();
    expect(store.document?.body.endsWith("\n")).toBe(true);
    const receiptDoc = store.getDocument(issueId, sessionTransitionReceiptDocumentKey(created.after.lastTransition.transitionId));
    expect(receiptDoc).toBeTruthy();
    const receipt = parseSessionTransitionReceiptBody(receiptDoc?.body ?? "");
    expect(receipt.recordedBy).toBe("paperclip-session-service");
    expect(receipt.companyId).toBe(companyId);
    expect(receipt.issueId).toBe(issueId);
    expect(receipt.sessionRevisionId).toBe(created.afterRevisionId);

    await expect(adapter.write({
      issueId,
      companyId,
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    })).rejects.toMatchObject({ status: 409 });

    await expect(adapter.write({
      issueId,
      companyId,
      expectedRevisionId: randomUUID(),
      expectedState: "open",
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    })).rejects.toMatchObject({ status: 409 });

    await expect(adapter.write({
      issueId,
      companyId,
      expectedRevisionId: created.afterRevisionId,
      expectedState: "completed",
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    })).rejects.toMatchObject({ status: 409 });

    const updated = await adapter.write({
      issueId,
      companyId,
      expectedRevisionId: created.afterRevisionId,
      expectedState: "open",
      nextState: makeSession({ companyId, issueId, state: "waiting_response", stateRevision: 1 }),
    });

    expect(updated.created).toBe(false);
    expect(updated.before?.state).toBe("open");
    expect(updated.after.state).toBe("waiting_response");
    expect(updated.beforeRevisionId).toBe(created.afterRevisionId);
    expect(updated.afterRevisionId).not.toBe(created.afterRevisionId);
  });

  it("rejects schema-valid generic session documents without a matching service transition receipt", async () => {
    const issueId = randomUUID();
    const companyId = randomUUID();
    const session = makeSession({ companyId, issueId });
    const store = createFakeStore({
      id: randomUUID(),
      companyId,
      issueId,
      key: "session",
      title: "Generic session write",
      format: "markdown",
      body: JSON.stringify(session),
      latestRevisionId: randomUUID(),
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "board-user",
      updatedByAgentId: null,
      updatedByUserId: "board-user",
      createdAt: new Date("2026-05-18T19:00:00.000Z"),
      updatedAt: new Date("2026-05-18T19:00:00.000Z"),
    });
    const adapter = createSessionStateAdapter(store);

    await expect(adapter.read(issueId)).rejects.toMatchObject({ status: 422 });
  });

  it("rejects session bodies whose issue or company scope does not match the envelope", async () => {
    const issueId = randomUUID();
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const store = createFakeStore();
    const adapter = createSessionStateAdapter(store);

    await expect(adapter.write({
      issueId,
      companyId,
      nextState: makeSession({ companyId: otherCompanyId, issueId }),
      actorAgentId: randomUUID(),
    })).rejects.toMatchObject({ status: 422 });
  });

  it("fails closed when the existing session document is malformed", async () => {
    const issueId = randomUUID();
    const store = createFakeStore({
      id: randomUUID(),
      companyId: randomUUID(),
      issueId,
      key: "session",
      title: "Broken session",
      format: "markdown",
      body: "{\"state\":\"open\"}",
      latestRevisionId: randomUUID(),
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: new Date("2026-05-18T19:00:00.000Z"),
      updatedAt: new Date("2026-05-18T19:00:00.000Z"),
    });
    const adapter = createSessionStateAdapter(store);

    await expect(adapter.read(issueId)).rejects.toMatchObject({ status: 422 });
  });

  it("keeps the ledger pivot as a hard decision when document-backed state lacks proof surfaces", () => {
    expect(evaluateSessionStateModelReadiness({
      inspectReliable: true,
      healthScanReliable: true,
      redactedReceiptLookupReliable: true,
      staleStateDetectionReliable: true,
      eodBacklogEnrollmentReliable: true,
    })).toEqual({ decision: "document_backed", blockers: [] });

    expect(evaluateSessionStateModelReadiness({
      inspectReliable: true,
      healthScanReliable: false,
      redactedReceiptLookupReliable: false,
      staleStateDetectionReliable: true,
      eodBacklogEnrollmentReliable: false,
    })).toEqual({
      decision: "pivot_to_ledger",
      blockers: ["health", "redacted_receipt_lookup", "eod_backlog_enrollment"],
    });
  });

  it("defines every R5 ad hoc trigger class with classifier proof hooks", () => {
    const expectedTriggerClasses = [
      "standup_nonresponse",
      "repeated_unanswered_directive",
      "full_paper_work_halt",
      "generator_nonproductive_state",
      "failed_or_stalled_review",
      "runtime_risk",
      "material_super_pass_event",
      "eod_material_finding",
      "permission_or_task_router_blocker",
    ];
    const framework = listCarSessionAdHocTriggerFramework();

    expect(framework.map((entry) => entry.triggerClass)).toEqual(expectedTriggerClasses);
    for (const spec of framework) {
      expect(spec.source).toBeTruthy();
      expect(spec.detector).toBeTruthy();
      expect(spec.dedupeKeyFields.length).toBeGreaterThan(0);
      expect(spec.severityInputs.length).toBeGreaterThan(0);
      expect(spec.capRule).toBeTruthy();
      expect(spec.overloadRule).toBeTruthy();
      expect(spec.correctionRule).toBeTruthy();
      expect(spec.reopenRule).toBeTruthy();
      expect(spec.noOpRule).toBeTruthy();
      expect(spec.ownerRole).toBeTruthy();

      const evaluated = evaluateCarSessionAdHocTrigger({
        triggerClass: spec.triggerClass,
        severityInputs: { severityScore: 0 },
        dedupeKey: `${spec.triggerClass}:test`,
        openSessionCount: 3,
        openTaskCount: 12,
        sessionCap: 3,
        taskCap: 12,
      });
      expect(evaluated.producer).toBe(spec.source);
      expect(evaluated.detector).toBe(spec.detector);
      expect(evaluated.capDecision).toBe("at_session_cap");
      expect(evaluated.overloadDecision).toBe(spec.overloadRule);
      expect(evaluated.noOpReason).toBe(spec.noOpRule);
      expect(evaluated.correctionTarget).toBe(spec.correctionRule);
      expect(evaluated.reopenTarget).toBe(spec.reopenRule);
      expect(evaluated.ownerRole).toBe(spec.ownerRole);
    }
  });
});
