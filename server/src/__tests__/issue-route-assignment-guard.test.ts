import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  assertInteractiveIssueCreateAssignee,
  assertInteractiveIssueUpdateAssignee,
} from "../routes/issues.js";

describe("interactive issue assignment guard", () => {
  it("rejects creating an unassigned issue", () => {
    expect(() =>
      assertInteractiveIssueCreateAssignee({
        assigneeAgentId: null,
        assigneeUserId: null,
      }),
    ).toThrowError(
      expect.objectContaining<HttpError>({
        status: 422,
        message: "Interactive issue creation requires an assignee",
      }),
    );
  });

  it("allows creating an issue with an assignee", () => {
    expect(() =>
      assertInteractiveIssueCreateAssignee({
        assigneeAgentId: "550e8400-e29b-41d4-a716-446655440000",
        assigneeUserId: null,
      }),
    ).not.toThrow();
  });

  it("rejects explicitly clearing the assignee on update", () => {
    expect(() =>
      assertInteractiveIssueUpdateAssignee(
        {
          assigneeAgentId: "550e8400-e29b-41d4-a716-446655440000",
          assigneeUserId: null,
        },
        {
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ),
    ).toThrowError(
      expect.objectContaining<HttpError>({
        status: 422,
        message: "Interactive issue updates cannot clear the assignee",
      }),
    );
  });

  it("allows updates that do not touch legacy unassigned issues", () => {
    expect(() =>
      assertInteractiveIssueUpdateAssignee(
        {
          assigneeAgentId: null,
          assigneeUserId: null,
        },
        {
          assigneeAgentId: undefined,
          assigneeUserId: undefined,
        },
      ),
    ).not.toThrow();
  });

  it("allows reassigning to a user", () => {
    expect(() =>
      assertInteractiveIssueUpdateAssignee(
        {
          assigneeAgentId: "550e8400-e29b-41d4-a716-446655440000",
          assigneeUserId: null,
        },
        {
          assigneeAgentId: null,
          assigneeUserId: "local-board",
        },
      ),
    ).not.toThrow();
  });
});
