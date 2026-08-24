import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parsePrpFixtureText,
  type PrpEvent,
  type PrpFixture,
} from "../protocol/replay-contract.js";
import {
  createSessionSnapshot,
  MAX_RECORDED_MISSING_SEQUENCES,
  reducePrpFixture,
  reduceSessionEvents,
  type SessionSnapshot,
} from "./session-reducer.js";

const fixtureDirectory = new URL(
  "../../protocol/fixtures/replay/",
  import.meta.url,
);
const fixtureNames = [
  "happy-path",
  "failed-run",
  "interrupted-run",
  "duplicate-event",
  "source-gap",
  "unknown-optional-fields",
];

async function loadFixture(name: string): Promise<PrpFixture> {
  const result = parsePrpFixtureText(
    await readFile(new URL(`${name}.json`, fixtureDirectory), "utf8"),
  );
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.fixture;
}

async function loadGolden(name: string): Promise<SessionSnapshot> {
  return JSON.parse(
    await readFile(
      new URL(`golden/${name}.snapshot.json`, fixtureDirectory),
      "utf8",
    ),
  ) as SessionSnapshot;
}

describe("deterministic PRP session reducer", () => {
  for (const fixtureName of fixtureNames) {
    it(`matches the ${fixtureName} golden snapshot`, async () => {
      expect(reducePrpFixture(await loadFixture(fixtureName))).toEqual(
        await loadGolden(fixtureName),
      );
    });
  }

  it("is deterministic and idempotent when the same batch is replayed", async () => {
    const fixture = await loadFixture("happy-path");
    const first = reducePrpFixture(fixture);
    expect(reducePrpFixture(fixture)).toEqual(first);
    expect(reduceSessionEvents(first, fixture.events)).toEqual(first);
  });

  it("deduplicates at-least-once delivery before projection effects", async () => {
    const snapshot = reducePrpFixture(await loadFixture("duplicate-event"));
    expect(snapshot.duplicateEventIds).toEqual(["event_duplicate_03"]);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.timeline).toHaveLength(6);
  });

  it("records a source cursor gap without inventing the missing event", async () => {
    const snapshot = reducePrpFixture(await loadFixture("source-gap"));
    expect(snapshot.integrity).toBe("gap_detected");
    expect(snapshot.gaps).toEqual([
      {
        sourceKey: "runner:runner_replay",
        expected: 3,
        received: 4,
        missingCount: 1,
        missing: [3],
        truncated: false,
      },
    ]);
  });

  it("bounds sequence-gap details for an untrusted large cursor jump", async () => {
    const fixture = await loadFixture("source-gap");
    const event: PrpEvent = {
      ...fixture.events[0]!,
      sourceEventId: "event_large_gap",
      sourceSeq: Number.MAX_SAFE_INTEGER,
    };

    const snapshot = reduceSessionEvents(createSessionSnapshot(fixture), [
      event,
    ]);

    expect(snapshot.gaps).toHaveLength(1);
    expect(snapshot.gaps[0]).toMatchObject({
      expected: 1,
      received: Number.MAX_SAFE_INTEGER,
      missingCount: Number.MAX_SAFE_INTEGER - 1,
      truncated: true,
    });
    expect(snapshot.gaps[0]?.missing).toHaveLength(
      MAX_RECORDED_MISSING_SEQUENCES,
    );
    expect(snapshot.gaps[0]?.missing.at(-1)).toBe(
      MAX_RECORDED_MISSING_SEQUENCES,
    );
  });

  it("summarizes runtime request creation and resolution with type and prompt", async () => {
    const fixture = await loadFixture("interrupted-run");
    const fixtureRequest = fixture.events.find(
      (event) => event.eventType === "runtime_request.created",
    );
    if (fixtureRequest === undefined) {
      throw new Error("interrupted-run fixture must create a runtime request");
    }
    const created: PrpEvent = {
      ...fixtureRequest,
      sourceEventId: "event_request_summary_01",
      sourceSeq: 1,
    };
    const resolved: PrpEvent = {
      ...fixtureRequest,
      sourceEventId: "event_request_summary_02",
      sourceSeq: 2,
      eventType: "runtime_request.resolved",
      payload: { requestId: "request_interrupted_permission" },
    };

    const snapshot = reduceSessionEvents(createSessionSnapshot(fixture), [
      created,
      resolved,
    ]);

    expect(snapshot.requests[0]).toMatchObject({ type: "permission" });
    expect(snapshot.timeline.map((entry) => entry.summary)).toEqual([
      "permission: Allow the fake command?",
      "Resolved permission: Allow the fake command?",
    ]);
  });
});
