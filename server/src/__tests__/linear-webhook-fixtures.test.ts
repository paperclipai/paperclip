import { describe, expect, it } from "vitest";
import {
  sanitizeLinearWebhookFixture,
  sanitizeLinearWebhookValue,
} from "../services/linear-webhook-fixtures.js";

describe("Linear webhook fixture sanitizer", () => {
  it("redacts free-form issue title and summary fields before fixtures are persisted", () => {
    const sanitized = sanitizeLinearWebhookFixture({
      name: "issue-update",
      headers: {
        "content-type": "application/json",
        "Linear-Signature": "raw-signature",
      },
      body: {
        type: "Issue",
        action: "update",
        data: {
          id: "lin-issue-001",
          identifier: "LIN-42",
          title: "Customer production outage",
          summary: "Private customer summary",
          description: "Private customer description",
          url: "https://linear.app/example/issue/LIN-42",
          team: {
            name: "Customer Team",
          },
        },
      },
    });

    const body = sanitized.body as Record<string, unknown>;
    const data = body.data as Record<string, unknown>;
    const team = data.team as Record<string, unknown>;

    expect(sanitized.headers["linear-signature"]).toBe("[redacted]");
    expect(data.title).toBe("[redacted]");
    expect(data.summary).toBe("[redacted]");
    expect(data.description).toBe("[redacted]");
    expect(data.url).toBe("[redacted]");
    expect(team.name).toBe("[redacted]");
  });

  it("redacts title and summary keys recursively", () => {
    expect(
      sanitizeLinearWebhookValue({
        nested: {
          title: "Private nested title",
          summary: "Private nested summary",
        },
      }),
    ).toEqual({
      nested: {
        title: "[redacted]",
        summary: "[redacted]",
      },
    });
  });
});
