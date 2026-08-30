import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  negotiateProtocolVersion,
  parsePrpFixtureText,
  PRP_PROTOCOL_VERSION,
} from "./replay-contract.js";

const fixtureDirectory = new URL(
  "../../protocol/fixtures/replay/",
  import.meta.url,
);
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
  "semantic-tool-unknown-optional-envelope.json",
];

async function readFixture(
  name = "happy-path.json",
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(new URL(name, fixtureDirectory), "utf8"),
  ) as Record<string, unknown>;
}

function reconciledEvent(
  events: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const reconciled = structuredClone(events[0]!);
  reconciled.sourceEventId = "semantic_happy_reconciled";
  reconciled.sourceSeq = 2;
  reconciled.eventType = "semantic_tool.reconciled";
  const payload = reconciled.payload as Record<string, unknown>;
  const semanticTool = payload.semantic_tool as Record<string, unknown>;
  const resultPayload = events[1]!.payload as Record<string, unknown>;
  const result = resultPayload.semantic_tool as Record<string, unknown>;
  semanticTool.phase = "reconciled";
  for (const field of [
    "content",
    "outcome",
    "code",
    "retryable",
    "authorizationBoundary",
    "operationReceiptId",
  ]) {
    semanticTool[field] = structuredClone(result[field]);
  }
  return reconciled;
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
      await readFile(
        new URL("unknown-optional-fields.json", fixtureDirectory),
        "utf8",
      ),
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
      await readFile(
        new URL("unsupported-required-version.json", fixtureDirectory),
        "utf8",
      ),
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
        new URL(
          "semantic-tool-unsupported-required-version.json",
          fixtureDirectory,
        ),
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

  it("accepts a pending semantic call closed by reconciliation alone", async () => {
    const fixture = await readFixture("semantic-tool-artifact-happy-path.json");
    const events = fixture.events as Array<Record<string, unknown>>;
    const reconciled = reconciledEvent(events);
    events[1] = reconciled;

    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: true,
    });

    const semanticTool = (
      reconciled.payload as Record<string, unknown>
    ).semantic_tool as Record<string, unknown>;
    delete semanticTool.outcome;
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "schema_validation" }),
      ]),
    });
  });

  it("binds reconciliation identity while preserving recovered result content", async () => {
    const fixture = await readFixture("semantic-tool-artifact-happy-path.json");
    const events = fixture.events as Array<Record<string, unknown>>;
    const reconciled = reconciledEvent(events);
    const payload = reconciled.payload as Record<string, unknown>;
    const semanticTool = payload.semantic_tool as Record<string, unknown>;
    events[1] = reconciled;

    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: true,
    });
    expect(
      (semanticTool.content as Record<string, unknown>).digest,
    ).toBe("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    semanticTool.operationId = "different_operation";
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "/events/1/payload/semantic_tool/operationId",
        }),
      ],
    });

    semanticTool.operationId = (
      (events[0]!.payload as Record<string, unknown>).semantic_tool as Record<
        string,
        unknown
      >
    ).operationId;
    reconciled.turnId = "different-turn";
    (semanticTool.correlation as Record<string, unknown>).turnId =
      "different-turn";
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "/events/1/payload/semantic_tool/correlation/turnId",
        }),
      ],
    });
  });

  it(
    "allows reconciliation to omit optional correlation metadata",
    async () => {
      const fixture = await readFixture(
        "semantic-tool-artifact-happy-path.json",
      );
      const events = fixture.events as Array<Record<string, unknown>>;
      const input = (events[0]!.payload as Record<string, unknown>)
        .semantic_tool as Record<string, unknown>;
      const inputCorrelation = input.correlation as Record<string, unknown>;
      inputCorrelation.requestId = "request_semantic_happy";
      inputCorrelation.futureTraceId = "trace_semantic_happy";

      const reconciled = reconciledEvent(events);
      const reconciledEnvelope = (
        reconciled.payload as Record<string, unknown>
      ).semantic_tool as Record<string, unknown>;
      const reconciledCorrelation = reconciledEnvelope.correlation as Record<
        string,
        unknown
      >;
      delete reconciledCorrelation.requestId;
      delete reconciledCorrelation.futureTraceId;
      events[1] = reconciled;

      expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
        ok: true,
      });
    },
  );

  it(
    "preserves replacement-runner provenance during reconciliation",
    async () => {
      const fixture = await readFixture(
        "semantic-tool-artifact-happy-path.json",
      );
      const events = fixture.events as Array<Record<string, unknown>>;
      const reconciled = reconciledEvent(events);
      const inputSourceInstanceId = events[0]!.sourceInstanceId;
      reconciled.sourceInstanceId = "runner_semantic_other";
      events[1] = reconciled;

      const result = parsePrpFixtureText(JSON.stringify(fixture));
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.fixture.events[0]?.sourceInstanceId).toBe(
          inputSourceInstanceId,
        );
        expect(result.fixture.events[1]?.sourceInstanceId).toBe(
          "runner_semantic_other",
        );
      }
    },
  );

  it("rejects result and reconciliation as two terminal phases for one call", async () => {
    const fixture = await readFixture("semantic-tool-artifact-happy-path.json");
    const events = fixture.events as Array<Record<string, unknown>>;
    const reconciled = reconciledEvent(events);
    for (const event of events.slice(1)) {
      event.sourceSeq = Number(event.sourceSeq) + 1;
    }
    events.splice(1, 0, reconciled);

    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "/events/0/payload/semantic_tool/callId",
          message: expect.stringContaining("exactly one result or reconciled"),
        }),
      ],
    });
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

  it("rejects source sequences that cannot be represented exactly", async () => {
    const fixture = await readFixture();
    const events = fixture.events as Array<Record<string, unknown>>;
    events[0]!.sourceSeq = Number.MAX_SAFE_INTEGER + 1;
    expect(parsePrpFixtureText(JSON.stringify(fixture))).toMatchObject({
      ok: false,
      issues: [
        {
          code: "schema_validation",
          path: "/events/0/sourceSeq",
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
    fixture.events = events.filter(
      (event) => event.eventType !== "run.terminal",
    );
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
    expect(
      negotiateProtocolVersion({ min: 2, max: 3 }, { min: 1, max: 1 }),
    ).toBeNull();
  });
});
