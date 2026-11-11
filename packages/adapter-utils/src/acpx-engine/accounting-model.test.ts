import { describe, expect, it } from "vitest";
import type { AcpRuntimeStatus } from "acpx/runtime";
import { acpxAccountingModel, acpxContextWindow } from "./accounting-model.js";

const selected = (id: string) => ({ models: { currentModelId: id, availableModelIds: [id] } });
describe("ACP accounting model", () => {
  it("retains the runtime's default and effective model instead of the requested label", () => {
    expect(acpxAccountingModel("", selected("gpt-6.1-sol"), selected("gpt-6.1-sol"))).toBe("gpt-6.1-sol");
    expect(acpxAccountingModel("default", null, selected("gpt-6-astra"))).toBe("gpt-6-astra");
    expect(acpxAccountingModel("", selected("gpt-6-astra"), null)).toBe("gpt-6-astra");
  });
  it("uses explicit configuration only when no selected model was reported", () => {
    expect(acpxAccountingModel("gpt-6.1-sol", null, null)).toBe("gpt-6.1-sol");
    expect(acpxAccountingModel("", { models: { availableModelIds: ["gpt-6.1-sol"] } }, null)).toBeNull();
  });
  it("does not price a turn that changed models as one model", () => {
    expect(acpxAccountingModel("gpt-6.1-sol", selected("gpt-6.1-sol"), selected("gpt-6-astra"))).toBeNull();
  });
});

describe("ACP context window resolution", () => {
  it("prefers a runtime-reported window over the configured value", () => {
    const status: AcpRuntimeStatus = { details: { modelContextWindow: 128000 } };
    expect(acpxContextWindow(status, null, 99999)).toBe(128000);
    expect(acpxContextWindow(null, status, 99999)).toBe(128000);
    expect(acpxContextWindow(status, status, undefined)).toBe(128000);
  });
  it("falls back to the configured value when no runtime window is reported", () => {
    expect(acpxContextWindow(null, null, 121600)).toBe(121600);
    expect(acpxContextWindow({ models: { availableModelIds: [] } }, null, 121600)).toBe(121600);
  });
  it("returns null when no source is known, never guessing", () => {
    expect(acpxContextWindow(null, null, undefined)).toBeNull();
    expect(acpxContextWindow(null, null, 0)).toBeNull();
    expect(acpxContextWindow(null, null, -5)).toBeNull();
    expect(acpxContextWindow(null, null, Number.NaN)).toBeNull();
    expect(acpxContextWindow(null, null, "128000" as unknown as number)).toBeNull();
  });
  it("ignores a non-numeric or non-positive reported window", () => {
    expect(acpxContextWindow({ details: { modelContextWindow: 0 } }, null, 5)).toBe(5);
    expect(acpxContextWindow({ details: { modelContextWindow: Number.NaN } }, null, 5)).toBe(5);
    expect(acpxContextWindow({ details: { modelContextWindow: "128000" as unknown as number } }, null, 5)).toBe(5);
  });
  it("floors fractional windows for stable diagnostics", () => {
    expect(acpxContextWindow(null, null, 121599.7)).toBe(121599);
  });
});
