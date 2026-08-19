import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  negotiateProtocolVersion,
  parsePrpFixtureText,
  PRP_PROTOCOL_VERSION,
} from "./replay-contract.js";
import { reducePrpFixture } from "../reducer/session-reducer.js";

const fixtureDirectory = new URL("../../protocol/fixtures/replay/", import.meta.url);
const validFixtures = [
  "happy-path.json",
  "failed-run.json",
  "interrupted-run.json",
  "duplicate-event.json",
  "source-gap.json",
  "unknown-optional-fields.json",
  "semantic-tool-artifact-happy-path.json",
  "semantic-tool-denial-redaction.json",
  "semantic-tool-conflict-duplicate-retry.json",
  "semantic-tool-governance-wake-monitor.json",
  "budget-cost-stop-reason.json",
  "semantic-tool-unknown-optional-envelope.json",
];

async function readFixture(name = "happy-path.json"): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(name, fixtureDirectory), "utf8"),
  ) as Record<string, unknown>;
}

describe("PRP v1 JSON Schema contract", () => {
  for (const fixtureName of validFixtures) {
    it(`validates ${fixtureName}`, async () => {
      const result = parsePrpFixtureText(
        await readFile(new URL(fixtureName, fixtureDirectory), "utf8"),
      );
      expect(result.ok).toBe(true);
    });
  }

  it("preserves unknown optional fields for forward compatibility", async () => {
    const result = parsePrpFixtureText(
      await readFile(new URL("unknown-optional-fields.json", fixtureDirectory), "utf8"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fixture.futureFixtureHint).toEqual({
        producerVersion: "1.1-preview",
      });
      expect(result.fixture.events[0]?.futureEnvelopeField).toBe(42);
    }
  });

  it("fails closed on an unsupported required protocol version", async () => {
    const result = parsePrpFixtureText(
      await readFile(new URL("unsupported-required-version.json", fixtureDirectory), "utf8"),
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: "unsupported_required_version",
          path: "/protocolVersion",
        },
      ],
    });
  });

  it("fails closed on an unsupported required semantic-tool version", async () => {
    const result = parsePrpFixtureText(
      await readFile(
        new URL("semantic-tool-unsupported-required-version.json", fixtureDirectory),
        "utf8",
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [
        {
          code: "unsupported_required_version",
          path: "/events/0/payload/semantic_tool/schemaVersion",
        },
      ],
    });
  });

  it("records an artifact receipt without projecting semantic-tool payload", async () => {
    const result = parsePrpFixtureText(
      await readFile(
        new URL("semantic-tool-artifact-happy-path.json", fixtureDirectory),
        "utf8",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const semantic = result.fixture.events[1]?.payload.semantic_tool;
    expect(semantic).toMatchObject({
      phase: "result",
      operationId: "register_deliverable",
      outcome: "succeeded",
      operationReceiptId: "receipt_semantic_happy",
      artifactRefs: [
        { kind: "artifact", id: "artifact_semantic_happy" },
        { kind: "work_product", id: "work_product_semantic_happy" },
      ],
    });
  });

  it("records a redacted denial with no fallback semantic call", async () => {
    const result = parsePrpFixtureText(
      await readFile(
        new URL("semantic-tool-denial-redaction.json", fixtureDirectory),
        "utf8",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const semanticEvents = result.fixture.events.filter(
      (event) => event.payload.semantic_tool !== undefined,
    );
    expect(semanticEvents).toHaveLength(2);
    expect(semanticEvents.map((event) => event.payload.semantic_tool?.operationId)).toEqual([
      "decide_approval",
      "decide_approval",
    ]);
    expect(semanticEvents[1]?.payload.semantic_tool).toMatchObject({
      outcome: "denied",
      code: "required_claim_missing",
      authorizationBoundary: "grant",
      content: { redactionDisposition: "redacted" },
    });
    expect(JSON.stringify(semanticEvents)).not.toContain("Bearer ");
  });

  it("links a stale conflict to an exact duplicate retry receipt", async () => {
    const result = parsePrpFixtureText(
      await readFile(
        new URL("semantic-tool-conflict-duplicate-retry.json", fixtureDirectory),
        "utf8",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipts = result.fixture.events
      .filter((event) => event.eventType === "mcp_app.tool_result")
      .map((event) => event.payload.semantic_tool);
    expect(receipts[0]).toMatchObject({
      outcome: "conflict",
      currentRevision: "revision_plan_2",
      retryable: true,
    });
    expect(receipts[2]).toMatchObject({
      outcome: "duplicate",
      operationReceiptId: receipts[1]?.operationReceiptId,
      duplicateOfReceiptId: receipts[1]?.operationReceiptId,
    });
  });

  it("deduplicates an at-least-once semantic source delivery before pair binding", async () => {
    const fixture = await readFixture("semantic-tool-artifact-happy-path.json");
    const events = fixture.events as Array<Record<string, unknown>>;
    events.splice(1, 0, structuredClone(events[0]!));
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({ ok: true });
  });

  it("binds immutable interaction and approval targets to a wake/monitor chain", async () => {
    const result = parsePrpFixtureText(
      await readFile(
        new URL("semantic-tool-governance-wake-monitor.json", fixtureDirectory),
        "utf8",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.fixture.events[1]?.payload.semantic_tool;
    expect(receipt?.targets).toEqual([
      {
        kind: "interaction",
        id: "interaction_semantic_governance",
        immutable: true,
        revisionId: "revision_plan_7",
      },
      {
        kind: "approval",
        id: "approval_semantic_governance",
        immutable: true,
        decisionId: "decision_approval_semantic_governance",
      },
    ]);
    expect(receipt?.causalRefs?.map((reference) => reference.kind)).toEqual([
      "document_revision",
      "interaction",
      "approval",
      "decision",
      "wake",
      "monitor",
    ]);
  });

  it("carries a budget/cost stop receipt on the terminal event", async () => {
    const result = parsePrpFixtureText(
      await readFile(new URL("budget-cost-stop-reason.json", fixtureDirectory), "utf8"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const terminal = result.fixture.events.find(
      (event) => event.eventType === "run.terminal",
    );
    expect(terminal?.payload.stopReason).toMatchObject({
      kind: "budget",
      code: "budget_hard_stop",
      decisionId: "budget_decision_stop",
      aggregate: { unit: "cents", observed: 10000, limit: 10000 },
    });
  });

  it("accepts unknown optional semantic fields without changing projection", async () => {
    const result = parsePrpFixtureText(
      await readFile(
        new URL("semantic-tool-unknown-optional-envelope.json", fixtureDirectory),
        "utf8",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fixture.events[0]?.payload.semantic_tool?.futureEnvelopeHint).toEqual({
      version: "1.1-preview",
    });

    const withoutEnvelope = structuredClone(result.fixture);
    for (const event of withoutEnvelope.events) {
      delete event.payload.semantic_tool;
    }
    expect(reducePrpFixture(result.fixture)).toEqual(reducePrpFixture(withoutEnvelope));
  });

  it("fails closed on unsupported nested required schema versions", async () => {
    const fixture = await readFixture();
    const events = fixture.events as Array<Record<string, unknown>>;
    events[0]!.schemaVersion = 2;
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        {
          code: "unsupported_required_version",
          path: "/events/0/schemaVersion",
        },
      ],
    });
  });

  it("requires the declared result to match the replayed result event", async () => {
    const fixture = await readFixture();
    const result = fixture.result as Record<string, unknown>;
    result.summary = "A contradictory expected result.";
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        {
          code: "binding_mismatch",
          path: "/result",
        },
      ],
    });
  });

  it("rejects a duplicate event id carrying different content", async () => {
    const fixture = await readFixture("duplicate-event.json");
    const events = fixture.events as Array<Record<string, unknown>>;
    const payload = events[3]!.payload as Record<string, unknown>;
    payload.text = "A mutated duplicate.";
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        {
          code: "binding_mismatch",
          path: "/events/3/sourceEventId",
        },
      ],
    });
  });

  it("requires exactly one unique terminal event", async () => {
    const fixture = await readFixture();
    const events = fixture.events as Array<Record<string, unknown>>;
    fixture.events = events.filter((event) => event.eventType !== "run.terminal");
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        {
          code: "binding_mismatch",
          path: "/events",
        },
      ],
    });
  });

  it("reports invalid JSON without throwing", () => {
    expect(parsePrpFixtureText("{")).toMatchObject({
      ok: false,
      issues: [{ code: "invalid_json", path: "/" }],
    });
  });

  it("selects only an overlapping supported protocol version", () => {
    expect(
      negotiateProtocolVersion(
        { min: 1, max: PRP_PROTOCOL_VERSION },
        { min: 1, max: 2 },
      ),
    ).toBe(1);
    expect(negotiateProtocolVersion({ min: 2, max: 3 }, { min: 1, max: 1 })).toBeNull();
  });
});
