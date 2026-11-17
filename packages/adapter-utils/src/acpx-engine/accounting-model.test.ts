import { describe, expect, it } from "vitest";
import { acpxAccountingModel } from "./accounting-model.js";

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
