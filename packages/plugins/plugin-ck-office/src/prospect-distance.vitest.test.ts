import assert from "node:assert/strict";
import { test } from "vitest";
import {
  calculateQueueRefill,
  buildOutreachTaskPairBrief,
  fetchDrivingMetrics,
  selectDistanceQueue,
} from "./prospect-distance.js";

test("task-pair brief preserves lane, account, and real driving evidence", () => {
  const brief = buildOutreachTaskPairBrief({
    account_id: "account-1",
    name: "Example Lounge",
    email: "info@example.ch",
    website: "https://example.ch",
    canton: "SO",
    city: "Olten",
    score: 85,
    score_reasons: ["+45 CRM priority Hoch", "+25 lounge placement fit"],
    distance_km: 18.4,
    duration_minutes: 19,
    outreach_lane: "local",
    distance_precision: "street",
  }, {
    origin: "Oberbuchsiten",
    activeRadiusKm: 35,
  });

  assert.match(brief.draftDescription, /^\[OUTREACH_LANE:local\]/);
  assert.match(brief.researchDescription, /Account ID: account-1/);
  assert.match(brief.draftDescription, /OSRM driving distance: 18.4 km/);
  assert.match(brief.draftDescription, /Do not send/);
});

test("queue capacity refills to ten local plus two exceptional instead of adding twelve", () => {
  assert.deepEqual(calculateQueueRefill({
    localTarget: 10,
    exceptionalTarget: 2,
    occupiedLocal: 6,
    occupiedExceptional: 1,
  }), {
    local: 4,
    exceptional: 1,
    total: 5,
  });
  assert.deepEqual(calculateQueueRefill({
    localTarget: 10,
    exceptionalTarget: 2,
    occupiedLocal: 10,
    occupiedExceptional: 2,
  }), {
    local: 0,
    exceptional: 0,
    total: 0,
  });
});

test("distance queue fills ten local slots and two exceptional nationwide slots", () => {
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    account_id: `account-${index + 1}`,
    score: 100 - index,
  }));
  const metrics = new Map(
    candidates.map((candidate, index) => [
      candidate.account_id,
      {
        distance_km: index < 10 ? 20 + index : 80 + index,
        duration_minutes: 20 + index,
      },
    ]),
  );

  const result = selectDistanceQueue(candidates, metrics, {
    origin: "Oberbuchsiten",
    localSlots: 10,
    exceptionalSlots: 2,
  });

  assert.equal(result.active_radius_km, 35);
  assert.equal(result.local.length, 10);
  assert.equal(result.exceptional.length, 2);
  assert.ok(result.local.every((candidate) => candidate.outreach_lane === "local"));
  assert.ok(result.exceptional.every((candidate) => candidate.distance_km > 35));
  assert.deepEqual(
    result.exceptional.map((candidate) => candidate.account_id),
    ["account-11", "account-12"],
  );
});

test("distance queue expands to the smallest band that can fill local capacity", () => {
  const candidates = [
    { account_id: "near", score: 70 },
    { account_id: "middle", score: 90 },
    { account_id: "far", score: 100 },
  ];
  const metrics = new Map([
    ["near", { distance_km: 20, duration_minutes: 20 }],
    ["middle", { distance_km: 60, duration_minutes: 55 }],
    ["far", { distance_km: 150, duration_minutes: 130 }],
  ]);

  const result = selectDistanceQueue(candidates, metrics, {
    origin: "Oberbuchsiten",
    localSlots: 2,
    exceptionalSlots: 1,
  });

  assert.equal(result.active_radius_km, 70);
  assert.deepEqual(result.local.map((candidate) => candidate.account_id), ["middle", "near"]);
  assert.deepEqual(result.exceptional.map((candidate) => candidate.account_id), ["far"]);
});

test("distance cannot promote a weak nearby account into the outreach queue", () => {
  const candidates = [
    { account_id: "weak-nearby", score: 25 },
    { account_id: "qualified", score: 80 },
  ];
  const metrics = new Map([
    ["weak-nearby", { distance_km: 5, duration_minutes: 5 }],
    ["qualified", { distance_km: 60, duration_minutes: 50 }],
  ]);

  const result = selectDistanceQueue(candidates, metrics, {
    origin: "Oberbuchsiten",
    localSlots: 2,
    exceptionalSlots: 0,
  });

  assert.deepEqual(result.local.map((candidate) => candidate.account_id), ["qualified"]);
});

test("OSRM table distances are converted to kilometres and minutes in batches", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({
      code: "Ok",
      distances: [[0, 12_345, 50_050]],
      durations: [[0, 1_500, 3_660]],
    }), { status: 200 });
  }) as typeof fetch;

  const result = await fetchDrivingMetrics(
    [47.3, 7.75],
    [
      { account_id: "one", coordinates: [47.4, 7.8] },
      { account_id: "two", coordinates: [47.8, 8.1] },
    ],
    fetchImpl,
  );

  assert.equal(urls.length, 1);
  assert.match(urls[0], /table\/v1\/driving/);
  assert.deepEqual(result.get("one"), { distance_km: 12.3, duration_minutes: 25 });
  assert.deepEqual(result.get("two"), { distance_km: 50.1, duration_minutes: 61 });
});
