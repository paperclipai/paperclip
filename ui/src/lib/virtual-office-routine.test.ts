import { describe, expect, it } from "vitest";
import { isVirtualOfficeRoutineLike } from "./virtual-office-routine";

describe("virtual office routine helpers", () => {
  it("detects Virtual Office sandbox routine drafts", () => {
    expect(isVirtualOfficeRoutineLike({ title: "Sandbox routine: 每日進度整理" })).toBe(true);
    expect(isVirtualOfficeRoutineLike({ title: "Daily review", description: "### 安全邊界\n只用 Sandbox/Test。" })).toBe(true);
    expect(isVirtualOfficeRoutineLike({ title: "Virtual Office weekly review" })).toBe(true);
  });

  it("does not mark ordinary routines as Virtual Office routines", () => {
    expect(isVirtualOfficeRoutineLike(null)).toBe(false);
    expect(isVirtualOfficeRoutineLike({ title: "Weekly customer report", description: "Send every Monday." })).toBe(false);
  });
});
