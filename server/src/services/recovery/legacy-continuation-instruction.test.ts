import { describe, expect, it } from "vitest";
import { LEGACY_DISPOSITION_REPAIR_INSTRUCTION } from "./legacy-continuation.js";

describe("LEGACY_DISPOSITION_REPAIR_INSTRUCTION", () => {
  it("tells an owner with unblocked unfinished work to continue it before recording the disposition", () => {
    expect(LEGACY_DISPOSITION_REPAIR_INSTRUCTION).toContain(
      "If the task is unfinished and nothing blocks it, continue the work in this run, then record the disposition.",
    );
  });

  it("still requires a recorded disposition and respects gates", () => {
    expect(LEGACY_DISPOSITION_REPAIR_INSTRUCTION).toContain("A final message alone does not record disposition.");
    expect(LEGACY_DISPOSITION_REPAIR_INSTRUCTION).toContain("Respect Stop, pause, budget and approval gates.");
  });
});
