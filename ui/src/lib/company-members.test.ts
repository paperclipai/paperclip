import { describe, expect, it } from "vitest";
import type { CompanyMember, CompanyUserDirectoryEntry } from "@/api/access";
import {
  buildCompanyUserInlineOptions,
  buildCompanyUserLabelMap,
  buildCompanyUserProfileMap,
  buildIssueMentionOptions,
  buildMarkdownMentionOptions,
} from "./company-members";

const activeMember = (overrides: Partial<CompanyMember>): CompanyMember => ({
  id: overrides.id ?? "member-1",
  companyId: overrides.companyId ?? "company-1",
  principalType: "user",
  principalId: overrides.principalId ?? "user-1",
  status: overrides.status ?? "active",
  membershipRole: overrides.membershipRole ?? "operator",
  createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  user: overrides.user === undefined
    ? { id: overrides.principalId ?? "user-1", name: "Taylor", email: "taylor@example.com", image: null }
    : overrides.user,
  grants: overrides.grants ?? [],
});

describe("company-members helpers", () => {
  it("builds labels from company member profiles", () => {
    const labels = buildCompanyUserLabelMap([
      activeMember({ principalId: "user-1", user: { id: "user-1", name: "Taylor", email: "taylor@example.com", image: null } }),
      activeMember({ id: "member-2", principalId: "local-board", user: null }),
    ]);

    expect(labels.get("user-1")).toBe("Taylor");
    expect(labels.get("local-board")).toBe("Board");
  });

  it("builds user profiles with labels and avatars", () => {
    const profiles = buildCompanyUserProfileMap([
      activeMember({
        principalId: "user-1",
        user: { id: "user-1", name: "Taylor", email: "taylor@example.com", image: "https://example.com/taylor.png" },
      }),
      activeMember({ id: "member-2", principalId: "local-board", user: null }),
    ]);

    expect(profiles.get("user-1")).toEqual({
      label: "Taylor",
      image: "https://example.com/taylor.png",
    });
    expect(profiles.get("local-board")).toEqual({
      label: "Board",
      image: null,
    });
  });

  it("builds inline options for active users and excludes requested ids", () => {
    const options = buildCompanyUserInlineOptions([
      activeMember({ principalId: "user-1", user: { id: "user-1", name: "Taylor", email: "taylor@example.com", image: null } }),
      activeMember({ id: "member-2", principalId: "user-2", user: { id: "user-2", name: "Jordan", email: "jordan@example.com", image: null } }),
      activeMember({ id: "member-3", principalId: "user-3", status: "suspended" }),
    ], { excludeUserIds: ["user-1"] });

    expect(options).toEqual([
      {
        id: "user:user-2",
        label: "Jordan",
        searchText: "Jordan jordan@example.com user-2",
      },
    ]);
  });

  it("includes human users in markdown mention options", () => {
    const options = buildMarkdownMentionOptions({
      members: [activeMember({ principalId: "user-1", user: { id: "user-1", name: "Taylor", email: "taylor@example.com", image: null } })],
      agents: [{ id: "agent-1", name: "CodexCoder", status: "active", icon: "code" }],
      projects: [{ id: "project-1", name: "Paperclip App", color: "#336699" }],
    });

    expect(options).toEqual([
      { id: "user:user-1", name: "Taylor", kind: "user", userId: "user-1" },
      { id: "agent:agent-1", name: "CodexCoder", kind: "agent", agentId: "agent-1", agentIcon: "code" },
      { id: "project:project-1", name: "Paperclip App", kind: "project", projectId: "project-1", projectColor: "#336699" },
    ]);
  });

  it("builds issue mention options with identifier + title search text", () => {
    const options = buildIssueMentionOptions([
      { id: "issue-1", identifier: "PAP-102", title: "@task references" },
      { id: "issue-2", identifier: "PAP-7", title: "" },
    ]);

    expect(options).toEqual([
      {
        id: "issue:issue-1",
        name: "PAP-102 @task references",
        kind: "issue",
        issueId: "issue-1",
        issueIdentifier: "PAP-102",
      },
      {
        id: "issue:issue-2",
        name: "PAP-7",
        kind: "issue",
        issueId: "issue-2",
        issueIdentifier: "PAP-7",
      },
    ]);
  });

  it("appends issue mention options after agents and projects, preserving order", () => {
    const options = buildMarkdownMentionOptions({
      agents: [{ id: "agent-1", name: "CodexCoder", status: "active", icon: "code" }],
      projects: [{ id: "project-1", name: "Paperclip App", color: "#336699" }],
      issues: [
        { id: "issue-2", identifier: "PAP-50", title: "Newer" },
        { id: "issue-1", identifier: "PAP-3", title: "Older" },
      ],
    });

    expect(options.map((option) => option.id)).toEqual([
      "agent:agent-1",
      "project:project-1",
      "issue:issue-2",
      "issue:issue-1",
    ]);
  });

  it("accepts read-only directory entries for assignee and mention helpers", () => {
    const users: CompanyUserDirectoryEntry[] = [
      {
        principalId: "user-1",
        status: "active",
        user: { id: "user-1", name: "Taylor", email: "taylor@example.com", image: null },
      },
    ];

    expect(buildCompanyUserInlineOptions(users)).toEqual([
      {
        id: "user:user-1",
        label: "Taylor",
        searchText: "Taylor taylor@example.com user-1",
      },
    ]);
    expect(buildMarkdownMentionOptions({ members: users })).toEqual([
      { id: "user:user-1", name: "Taylor", kind: "user", userId: "user-1" },
    ]);
  });
});
