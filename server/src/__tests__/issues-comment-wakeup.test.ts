import { describe, it, expect } from "vitest";
import { commentWakeConfig } from "../routes/issues-comment-wakeup.js";

describe("commentWakeConfig", () => {
  it("uses issue_comment_board reason for board user comments", () => {
    const config = commentWakeConfig(false);
    expect(config.reason).toBe("issue_comment_board");
    expect(config.source).toBe("issue.comment.board");
    expect(config.wakeReason).toBe("issue_comment_board");
  });

  it("uses issue_commented reason for agent comments", () => {
    const config = commentWakeConfig(true);
    expect(config.reason).toBe("issue_commented");
    expect(config.source).toBe("issue.comment");
    expect(config.wakeReason).toBe("issue_commented");
  });
});
