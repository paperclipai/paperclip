import { describe, expect, it } from "vitest";
import { ISSUE_ORIGIN_KINDS } from "@paperclipai/shared";
import {
  OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND,
  legacyOperationalIncidentFingerprint,
  operationalIncidentFingerprint,
} from "../services/ceo-control-room.ts";

describe("CEO control-room operational-loop incident fingerprinting", () => {
  it("uses a shared origin kind for operational-loop incidents", () => {
    expect(OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND).toBe("operational_loop_incident");
    expect(ISSUE_ORIGIN_KINDS).toContain(OPERATIONAL_LOOP_INCIDENT_ORIGIN_KIND);
  });

  it("keys routine incidents by routine id so title changes keep the same incident", () => {
    const routineId = "11111111-1111-4111-8111-111111111111";

    expect(operationalIncidentFingerprint({
      routineId,
      routineTitle: "Market data liveness",
    })).toBe(`operational-loop:routine:${routineId}`);
    expect(operationalIncidentFingerprint({
      routineId,
      routineTitle: "Market data liveness renamed",
    })).toBe(`operational-loop:routine:${routineId}`);
  });

  it("normalizes title-only incidents and preserves the legacy fingerprint fallback", () => {
    expect(operationalIncidentFingerprint({
      routineTitle: "  Market   Data Liveness  ",
    })).toBe("operational-loop:title:market data liveness");
    expect(legacyOperationalIncidentFingerprint("Market Data Liveness")).toBe(
      "operational-loop:Market Data Liveness",
    );
  });
});
