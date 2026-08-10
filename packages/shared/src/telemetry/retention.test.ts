import { describe, expect, it } from "vitest";
import {
  EVENT_RETENTION_CLASS,
  RETENTION_DAYS,
} from "./retention.js";

describe("telemetry retention contract", () => {
  it("operational_enum_count has a 90-day retention window", () => {
    expect(RETENTION_DAYS.operational_enum_count).toBe(90);
  });

  it("codex.credential_health is assigned the operational_enum_count class", () => {
    expect(EVENT_RETENTION_CLASS["codex.credential_health"]).toBe("operational_enum_count");
  });

  it("codex.credential_health resolves to 90 days", () => {
    const cls = EVENT_RETENTION_CLASS["codex.credential_health"];
    expect(cls).toBeDefined();
    expect(RETENTION_DAYS[cls!]).toBe(90);
  });
});
