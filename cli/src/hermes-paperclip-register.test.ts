import { describe, expect, it } from "vitest";
import { buildExistingIssueUpdatePatch, buildListSummary } from "./hermes-paperclip-register-utils";

describe("hermes-paperclip-register", () => {
  it("lists companies with their projects and issues without connection details", () => {
    const summary = buildListSummary({
      databaseSource: "embedded-postgres@54329",
      companies: [
        { id: "company-1", name: "JP Personal AI Ops", status: "active", issuePrefix: "JPP" },
      ],
      projects: [
        { id: "project-1", companyId: "company-1", name: "AI Agents Visual Cockpit", status: "in_progress" },
      ],
      issues: [
        {
          id: "issue-1",
          companyId: "company-1",
          projectId: "project-1",
          identifier: "JPP-4",
          title: "VM-Alfred Paperclip heartbeat and fallback runbook",
          status: "done",
          priority: "high",
        },
      ],
    });

    expect(summary).toEqual({
      databaseSource: "embedded-postgres@54329",
      companies: [
        {
          id: "company-1",
          name: "JP Personal AI Ops",
          status: "active",
          issuePrefix: "JPP",
          projects: [
            {
              id: "project-1",
              name: "AI Agents Visual Cockpit",
              status: "in_progress",
              issues: [
                {
                  id: "issue-1",
                  identifier: "JPP-4",
                  title: "VM-Alfred Paperclip heartbeat and fallback runbook",
                  status: "done",
                  priority: "high",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("builds a minimal patch when an existing issue should be synchronized", () => {
    const patch = buildExistingIssueUpdatePatch(
      { status: "todo", priority: "medium", description: "old" },
      { status: "done", priority: "high", description: "new" },
    );

    expect(patch).toEqual({ status: "done", priority: "high", description: "new" });
  });

  it("returns null when an existing issue already matches the requested fields", () => {
    const patch = buildExistingIssueUpdatePatch(
      { status: "done", priority: "high", description: "same" },
      { status: "done", priority: "high", description: "same" },
    );

    expect(patch).toBeNull();
  });
});
