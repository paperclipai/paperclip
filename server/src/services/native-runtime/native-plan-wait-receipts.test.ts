import { describe, expect, it } from "vitest";
import { readCommittedPlanWaitReceipt } from "./native-plan-wait-receipts.js";

describe("committed plan-wait receipt formats", () => {
  const modern = { planWait: { schema: "paperclip.native_plan_wait.v1" }, planWaitResult: { resultId: "new" } };
  const legacy = { cursorPlanWait: { schema: "paperclip.native_cursor_plan_wait.v1" }, cursorPlanWaitResult: { resultId: "old" } };

  it("reads each format without rewriting its source or accepted result identity", () => {
    expect(readCommittedPlanWaitReceipt(modern)).toMatchObject({ source: modern.planWait, identity: modern.planWaitResult, format: { legacy: false } });
    expect(readCommittedPlanWaitReceipt(legacy)).toMatchObject({ source: legacy.cursorPlanWait, identity: legacy.cursorPlanWaitResult, format: { legacy: true } });
    expect(legacy.cursorPlanWait.schema).toBe("paperclip.native_cursor_plan_wait.v1");
  });

  it.each([
    { ...modern, ...legacy }, { ...modern, cursorPlanWaitResult: legacy.cursorPlanWaitResult },
    { ...legacy, planWaitResult: modern.planWaitResult },
    { planWait: legacy.cursorPlanWait }, { cursorPlanWait: modern.planWait },
    { planWait: { schema: "future" } }, {}, null,
  ])("rejects mixed, relabeled or unknown authority formats: %j", value => {
    expect(readCommittedPlanWaitReceipt(value)).toBeNull();
  });
});
