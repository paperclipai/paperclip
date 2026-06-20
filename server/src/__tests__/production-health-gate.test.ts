import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProductionHealthyForClosure,
  getProductionHealthTargets,
  isProductionIncidentIssue,
  ProductionHealthGateError,
  type ProductionHealthResult,
  type ProductionHealthTarget,
} from "../services/production-health-gate.js";

const TARGETS_JSON = JSON.stringify({
  targets: [
    { name: "pulse-web", url: "https://pulse-web-prod.example.app", expect: { status: 200 } },
    { name: "pulse", url: "https://getpulse-app.example.app", expect: { status: 200 } },
  ],
});

const envWith = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PRODUCTION_HEALTH_TARGETS: TARGETS_JSON,
  ...extra,
});

const incidentIssue = { title: "P0: Production Down — all routes 401", labels: [] };
const ordinaryIssue = { title: "Tweak button padding on settings page", labels: ["ui"] };

const allHealthy = (t: ProductionHealthTarget): Promise<ProductionHealthResult> =>
  Promise.resolve({ name: t.name, url: t.url, healthy: true, status: 200 });
const oneDown = (t: ProductionHealthTarget): Promise<ProductionHealthResult> =>
  Promise.resolve(
    t.name === "pulse"
      ? { name: t.name, url: t.url, healthy: false, status: 401, reason: "got 401, expected 200" }
      : { name: t.name, url: t.url, healthy: true, status: 200 },
  );

describe("getProductionHealthTargets", () => {
  it("returns [] when unconfigured", () => {
    expect(getProductionHealthTargets({})).toEqual([]);
  });
  it("parses the {targets:[...]} shape", () => {
    expect(getProductionHealthTargets(envWith()).map((t) => t.name)).toEqual(["pulse-web", "pulse"]);
  });
});

describe("isProductionIncidentIssue", () => {
  it("matches a production-incident title", () => {
    expect(isProductionIncidentIssue(incidentIssue, envWith())).toBe(true);
  });
  it("matches a configured label", () => {
    expect(isProductionIncidentIssue({ title: "x", labels: ["outage"] }, envWith())).toBe(true);
  });
  it("ignores ordinary issues", () => {
    expect(isProductionIncidentIssue(ordinaryIssue, envWith())).toBe(false);
  });
});

describe("assertProductionHealthyForClosure", () => {
  it("blocks closing a production incident when a target is down", async () => {
    await expect(
      assertProductionHealthyForClosure({
        issue: incidentIssue,
        existingStatus: "in_progress",
        requestedStatus: "done",
        env: envWith(),
        probeFn: oneDown,
      }),
    ).rejects.toBeInstanceOf(ProductionHealthGateError);
  });

  it("allows closing when all targets are healthy", async () => {
    await expect(
      assertProductionHealthyForClosure({
        issue: incidentIssue,
        existingStatus: "in_progress",
        requestedStatus: "done",
        env: envWith(),
        probeFn: allHealthy,
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when the issue is not a production incident", async () => {
    await expect(
      assertProductionHealthyForClosure({
        issue: ordinaryIssue,
        existingStatus: "in_progress",
        requestedStatus: "done",
        env: envWith(),
        probeFn: oneDown, // would throw if it ran
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when not transitioning into a closed status", async () => {
    await expect(
      assertProductionHealthyForClosure({
        issue: incidentIssue,
        existingStatus: "todo",
        requestedStatus: "in_progress",
        env: envWith(),
        probeFn: oneDown,
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when the issue is already closed (no re-gate)", async () => {
    await expect(
      assertProductionHealthyForClosure({
        issue: incidentIssue,
        existingStatus: "done",
        requestedStatus: "done",
        env: envWith(),
        probeFn: oneDown,
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops (fail-open) when the gate is unconfigured", async () => {
    await expect(
      assertProductionHealthyForClosure({
        issue: incidentIssue,
        existingStatus: "in_progress",
        requestedStatus: "done",
        env: {},
        probeFn: oneDown,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("probe (real fetch path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows redirects and treats a settled 200 as healthy", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        inits.push(init);
        return Promise.resolve(new Response("ok", { status: 200 }));
      }),
    );

    // No probeFn -> the real probe() runs, exercising the fetch call.
    await expect(
      assertProductionHealthyForClosure({
        issue: incidentIssue,
        existingStatus: "in_progress",
        requestedStatus: "done",
        env: envWith(),
      }),
    ).resolves.toBeUndefined();

    // One probe per configured target, each following redirects (not "manual",
    // which would yield an opaque status 0 and falsely fail a healthy endpoint).
    expect(inits).toHaveLength(2);
    expect(inits.every((init) => init.redirect === "follow")).toBe(true);
  });
});
