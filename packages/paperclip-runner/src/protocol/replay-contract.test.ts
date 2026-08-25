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
];

async function readFixture(
  name = "happy-path.json",
): Promise<Record<string, unknown>> {
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
