import { describe, expect, it } from "vitest";
import { describeRunProgress } from "./runProgressExplanation";

describe("describeRunProgress", () => {
  it("explains active and terminal run states in operator language", () => {
    expect(describeRunProgress({ status: "queued" }).description).toContain("has not started");
    expect(describeRunProgress({ status: "running" }).description).toContain("worker is acting");
    expect(describeRunProgress({ status: "succeeded", livenessState: "advanced" }).label).toBe("Completed");
    expect(describeRunProgress({
      status: "failed",
      livenessReason: "Process exited with code 1",
    }).description).toBe("Process exited with code 1");
    expect(describeRunProgress({
      status: "succeeded",
      livenessState: "blocked",
      livenessReason: "Waiting for approval_id",
    }).label).toBe("Blocked");
  });

  it("uses Korean copy when the locale is Korean", () => {
    expect(describeRunProgress({ status: "queued" }, "ko-KR")).toMatchObject({
      label: "실행 대기",
      description: "직원 실행 슬롯을 기다리는 중이며 아직 시작되지 않았습니다.",
    });
    expect(describeRunProgress({ status: "running" }, "ko")).toMatchObject({
      label: "실행 중",
    });
  });
});

