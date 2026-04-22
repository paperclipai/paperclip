import { describe, it, expect, vi } from "vitest";
import { Monitor } from "../src/monitor.js";
import type { AuditEntryLite } from "../src/audit-tail.js";

function entry(overrides: Partial<AuditEntryLite> = {}): AuditEntryLite {
  return {
    ts: new Date().toISOString(),
    blocked: false,
    ...overrides,
  };
}

describe("Monitor", () => {
  it("fires on art_9 block", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    expect(alert).toHaveBeenCalledTimes(1);
    const [msg] = alert.mock.calls[0]!;
    expect(msg).toMatch(/art_9/i);
  });

  it("dedupes same trigger within window", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("fires again after dedup window expires", () => {
    const alert = vi.fn();
    let t = 1000;
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => t });
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    t += 601_000;
    m.evaluate([entry({ blocked: true, blockedReason: "art_9_data_detected" })]);
    expect(alert).toHaveBeenCalledTimes(2);
  });

  it("fires on 3rd consecutive classifier-unreachable", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("unreachable");
    expect(alert).not.toHaveBeenCalled();
    m.recordClassifierStatus("unreachable");
    expect(alert).toHaveBeenCalledTimes(1);
    const [msg] = alert.mock.calls[0]!;
    expect(msg).toMatch(/classifier/i);
  });

  it("resets classifier counter on reachable", () => {
    const alert = vi.fn();
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => 1000 });
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("reachable");
    m.recordClassifierStatus("unreachable");
    m.recordClassifierStatus("unreachable");
    expect(alert).not.toHaveBeenCalled();
  });

  it("fires when error rate exceeds 10/hour", () => {
    const alert = vi.fn();
    let t = 1000;
    const m = new Monitor({ alertFn: alert, dedupMs: 600_000, now: () => t });
    // dpo_unavailable counts as an error
    for (let i = 0; i < 11; i++) {
      m.evaluate([entry({ blocked: true, blockedReason: "dpo_unavailable" })]);
      t += 1000;
    }
    expect(alert).toHaveBeenCalled();
    expect(alert.mock.calls.some(([msg]) => /rate/i.test(String(msg)))).toBe(true);
  });
});
