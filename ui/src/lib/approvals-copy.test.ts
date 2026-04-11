import { describe, expect, it } from "vitest";
import { getApprovalsCopy } from "./approvals-copy";

describe("approvals-copy", () => {
  it("returns Chinese approvals page labels", () => {
    const copy = getApprovalsCopy("zh-CN");

    expect(copy.title).toBe("审批");
    expect(copy.pending).toBe("待处理");
    expect(copy.all).toBe("全部");
    expect(copy.noPending).toBe("暂无待处理审批。");
  });
});
