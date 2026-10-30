import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { skillCreatedItems } from "./skill-created-items";

const event = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "activity",
  companyId: "company",
  actorType: "agent",
  actorId: "agent",
  action: "company.skill_created",
  entityType: "company_skill",
  entityId: "skill",
  createdAt: new Date("2026-09-16T12:00:00Z"),
  details: { name: "Release helper", description: "Ships releases.", slug: "release-helper", versionId: "version" },
  ...overrides,
} as ActivityEvent);

describe("durable skill creation feed", () => {
  it("deduplicates repeated persisted receipts and keeps metadata", () => {
    expect(skillCreatedItems([event(), event({ id: "replay" })])).toEqual([expect.objectContaining({
      id: "skill-created:skill", kind: "skill_created", skillId: "skill", name: "Release helper", slug: "release-helper", versionId: "version",
    })]);
  });

  it("ignores unrelated activity and malformed receipts", () => {
    expect(skillCreatedItems([event({ action: "issue.comment_added" }), event({ details: {} })])).toEqual([]);
  });
});
