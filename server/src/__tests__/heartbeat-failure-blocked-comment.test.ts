import { describe, expect, it } from "vitest";
import { buildBlockedCommentForFailedRun } from "../services/heartbeat.js";

describe("buildBlockedCommentForFailedRun", () => {
  it("실패 상태에 대해 blocked 안내 코멘트를 생성한다", () => {
    const body = buildBlockedCommentForFailedRun({
      id: "run-failed-1",
      status: "failed",
      errorCode: "openclaw_gateway_request_failed",
      error: "gateway rejected request",
    } as never);

    expect(body).toContain("## 실행 실패로 인한 자동 차단");
    expect(body).toContain("현재 실행이 실패되어 이슈를 `blocked`로 전환했습니다.");
    expect(body).toContain("- 오류 코드: `openclaw_gateway_request_failed`");
    expect(body).toContain("- 오류 메시지: gateway rejected request");
    expect(body).toContain("- 실행 ID: `run-failed-1`");
  });

  it("타임아웃 상태에 대해 blocked 안내 코멘트를 생성한다", () => {
    const body = buildBlockedCommentForFailedRun({
      id: "run-timeout-1",
      status: "timed_out",
      errorCode: "openclaw_gateway_wait_timeout",
      error: "Timed out",
    } as never);

    expect(body).toContain("현재 실행이 타임아웃되어 이슈를 `blocked`로 전환했습니다.");
    expect(body).toContain("- 오류 코드: `openclaw_gateway_wait_timeout`");
    expect(body).toContain("- 실행 ID: `run-timeout-1`");
  });
});
