import { describe, it, expect } from "vitest";
import { Registry } from "../services/routine-checks/registry.ts";
import type { CheckDef } from "../services/routine-checks/types.ts";

const buildDef = (overrides: Partial<CheckDef> = {}): CheckDef => ({
  name: "x",
  schedule: "*/5 * * * *",
  notify: "silent",
  run: async () => ({ status: "ok", findings: 0, payload: {}, summary: "" }),
  ...overrides,
});

describe("Registry", () => {
  it("registers a check by name", () => {
    const r = new Registry();
    const def = buildDef();
    r.register(def);
    expect(r.get("x")).toBe(def);
  });

  it("returns undefined for unknown name", () => {
    const r = new Registry();
    expect(r.get("missing")).toBeUndefined();
  });

  it("throws on duplicate name", () => {
    const r = new Registry();
    r.register(buildDef());
    expect(() => r.register(buildDef())).toThrow(/duplicate/i);
  });

  it("throws on invalid cron expression", () => {
    const r = new Registry();
    expect(() => r.register(buildDef({ schedule: "not-a-cron" }))).toThrow(
      /Invalid schedule for "x"/,
    );
  });

  it("lists all registered checks", () => {
    const r = new Registry();
    r.register(buildDef());
    r.register(buildDef({ name: "y" }));
    expect(r.list().map((d) => d.name).sort()).toEqual(["x", "y"]);
  });

  it("list returns a snapshot, not a live reference", () => {
    const r = new Registry();
    r.register(buildDef());
    const snapshot = r.list();
    r.register(buildDef({ name: "z" }));
    expect(snapshot).toHaveLength(1);
  });
});
