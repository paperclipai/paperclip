import { describe, expect, it } from "vitest";
import {
  buildSkillUsageInsertRows,
  parsePaperclipSkillUsageEvent,
} from "./skill-usage-events.js";

describe("parsePaperclipSkillUsageEvent", () => {
  it("returns a normalized event payload for loaded skill usage events", () => {
    expect(
      parsePaperclipSkillUsageEvent({
        eventType: "paperclip.skill.usage",
        payload: {
          adapter: "claude",
          eventKind: "loaded",
          skillKey: "Company/Skill/Test",
          skillRuntimeName: "test-skill",
          skillVersionId: " 1234 ",
        },
      }),
    ).toEqual({
      adapter: "claude",
      eventKind: "loaded",
      skillKey: "Company/Skill/Test",
      skillRuntimeName: "test-skill",
      skillVersionId: "1234",
    });
  });

  it("returns null for non usage events", () => {
    expect(
      parsePaperclipSkillUsageEvent({
        eventType: "adapter.invoke",
        payload: { adapter: "claude", eventKind: "loaded", skillKey: "skill" },
      }),
    ).toBeNull();
  });

  it("returns null for invalid event kinds", () => {
    expect(
      parsePaperclipSkillUsageEvent({
        eventType: "paperclip.skill.usage",
        payload: { adapter: "claude", eventKind: "used", skillKey: "skill" },
      }),
    ).toBeNull();
  });
});

describe("buildSkillUsageInsertRows", () => {
  it("dedupes identical events and resolves skill ids", () => {
    const companyId = "company-1";
    const agentId = "agent-1";
    const runId = "run-1";
    const issueId = "issue-1";
    const rows = buildSkillUsageInsertRows({
      companyId,
      agentId,
      runId,
      issueId,
      events: [
        { adapter: "claude", eventKind: "loaded", skillKey: "company/test/skill", skillRuntimeName: "x", skillVersionId: null },
        { adapter: "claude", eventKind: "loaded", skillKey: "company/test/skill", skillRuntimeName: "x", skillVersionId: "ver-1" },
        { adapter: "codex", eventKind: "loaded", skillKey: "company/test/skill", skillRuntimeName: "x", skillVersionId: null },
        { adapter: "claude", eventKind: "invoked", skillKey: "company/test/skill", skillRuntimeName: "x", skillVersionId: null },
      ],
      skillIdByKey: new Map([
        ["company/test/skill", "skill-id-1"],
      ]),
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      companyId,
      agentId,
      runId,
      issueId,
      adapter: "claude",
      skillKey: "company/test/skill",
      skillId: "skill-id-1",
      eventKind: "loaded",
    });
    expect(rows.every((row) => row.skillId === "skill-id-1")).toBe(true);
  });

  it("keeps unknown skill keys unresolved", () => {
    expect(
      buildSkillUsageInsertRows({
        companyId: "company-1",
        agentId: "agent-1",
        runId: "run-1",
        issueId: null,
        events: [{
          adapter: "claude",
          eventKind: "loaded",
          skillKey: "company/missing",
          skillRuntimeName: null,
          skillVersionId: null,
        }],
        skillIdByKey: new Map(),
      }),
    ).toEqual([
      expect.objectContaining({
        companyId: "company-1",
        skillKey: "company/missing",
        skillId: null,
        adapter: "claude",
        eventKind: "loaded",
      }),
    ]);
  });
});
