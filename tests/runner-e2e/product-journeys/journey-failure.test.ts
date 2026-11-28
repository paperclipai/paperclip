import { describe, expect, it } from "vitest";
import { ConnectionFailure } from "../connection-config.js";
import { editCreatedSkillThroughStudio } from "../skill-studio-flow.js";
import { journeyFailure } from "./launch.js";

describe("journeyFailure", () => {
  it("keeps the controlled HTTP status code from a failed API request", () => {
    expect(journeyFailure(new ConnectionFailure("api_status_500"))).toEqual({ outcome: "failed", code: "api_status_500" });
    expect(journeyFailure(new ConnectionFailure("api_status_409"))).toEqual({ outcome: "failed", code: "api_status_409" });
  });

  it("keeps the controlled transport failure codes", () => {
    for (const code of ["api_request_failed", "sensitive_api_request_failed", "invalid_api_route", "invalid_api_timeout"]) {
      expect(journeyFailure(new ConnectionFailure(code))).toEqual({ outcome: "failed", code });
    }
  });

  it("matches a connection failure loaded from another module instance by its class name", () => {
    class ConnectionFailure extends Error {}
    expect(journeyFailure(new ConnectionFailure("api_status_502"))).toEqual({ outcome: "failed", code: "api_status_502" });
  });

  it("keeps the Studio step through final journey grading without browser details", async () => {
    const page = { getByRole() { throw new Error("https://private.example/?token=secret skill-body"); } };
    const error = await editCreatedSkillThroughStudio({ page: page as never, skillId: "owned", skillName: "owned",
      marker: "marker", deadlineAt: Date.now() + 1000, read: async () => ({}) }).catch(error => error);
    expect(journeyFailure(error)).toEqual({ outcome: "failed", code: "skill_studio_open_card_failed" });
    expect(JSON.stringify(error)).not.toMatch(/private|token|secret|skill-body/);
    expect(error.cause).toBeUndefined();
  });

  it("never retains free-form messages", () => {
    expect(journeyFailure(new ConnectionFailure("api_status_500 https://example.test/?token=secret"))).toEqual({ outcome: "failed", code: "journey_operation_failed" });
    expect(journeyFailure(new Error("api_status_500"))).toEqual({ outcome: "failed", code: "journey_operation_failed" });
    expect(journeyFailure(new Error("page.click: Timeout 30000ms exceeded"))).toEqual({ outcome: "failed", code: "journey_operation_failed" });
  });
});
