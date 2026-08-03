import { describe, expect, it } from "vitest";
import {
  buildMattermostAssignmentPayload,
  normalizeOrgChartRows,
  parseOrgChartCsv,
  validateOrgChartRows,
} from "../src/model.js";

describe("human org-chart import model", () => {
  it("parses CSV with quoted values and pipe-separated capabilities and responsibilities", () => {
    const rows = parseOrgChartCsv([
      "external_id,name,email,title,reports_to_external_id,capabilities,responsibilities,mattermost_username,paperclip_user_id,status",
      'exec-1,"Asha, Patel",asha@example.com,CEO,,strategy|budget,"Set direction|Approve budget",asha,,active',
      "eng-1,Diego Ruiz,diego@example.com,Engineer,exec-1,typescript|aws,Build services|Review code,diego,user-123,active",
    ].join("\n"));

    expect(rows).toEqual([
      expect.objectContaining({
        externalId: "exec-1",
        name: "Asha, Patel",
        capabilities: ["strategy", "budget"],
        responsibilities: ["Set direction", "Approve budget"],
        reportsToExternalId: null,
      }),
      expect.objectContaining({
        externalId: "eng-1",
        reportsToExternalId: "exec-1",
        paperclipUserId: "user-123",
      }),
    ]);
  });

  it("rejects invalid statuses during CSV parsing instead of coercing them to active", () => {
    expect(() => parseOrgChartCsv([
      "external_id,name,status",
      "person-1,Asha Patel,paused",
    ].join("\n"))).toThrow("status must be active or inactive");
  });

  it.each([
    ["unknown headers", "external_id,name,admin_flag\nperson-1,Asha,true", "Unknown CSV header"],
    ["duplicate normalized headers", "external_id,externalId,name\nperson-1,duplicate,Asha", "Duplicate CSV header"],
    ["inconsistent row widths", "external_id,name,status\nperson-1,Asha", "has 2 cells; expected 3"],
    ["quotes inside unquoted fields", 'external_id,name\nperson-1,Ash"a', "Malformed CSV quote"],
  ])("rejects %s", (_label, input, expectedMessage) => {
    expect(() => parseOrgChartCsv(input)).toThrow(expectedMessage);
  });

  it("rejects oversized imports and profile fields", () => {
    expect(() => parseOrgChartCsv("x".repeat(2_000_001))).toThrow("2,000,000 characters");
    expect(() => normalizeOrgChartRows(Array.from({ length: 5_001 }, (_value, index) => ({
      externalId: `person-${index}`,
      name: `Person ${index}`,
    })))).toThrow("5,000 people");
    expect(validateOrgChartRows([{
      externalId: "person-1",
      name: "x".repeat(201),
    }])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "input_limit", externalId: "person-1" }),
    ]));
  });

  it("rejects duplicate identities, missing managers, and reporting cycles", () => {
    expect(validateOrgChartRows([
      { externalId: "a", name: "A", reportsToExternalId: "missing" },
      { externalId: "a", name: "Duplicate A", reportsToExternalId: null },
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate_external_id", externalId: "a" }),
      expect.objectContaining({ code: "unknown_manager", externalId: "a" }),
    ]));

    expect(validateOrgChartRows([
      { externalId: "a", name: "A", reportsToExternalId: "b" },
      { externalId: "b", name: "B", reportsToExternalId: "a" },
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reporting_cycle" }),
    ]));

    expect(validateOrgChartRows([
      { externalId: "broadcast", name: "Broadcast", mattermostUsername: "channel" },
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_mattermost_username", externalId: "broadcast" }),
    ]));
  });

  it("builds a Mattermost payload with a direct mention and Paperclip issue link", () => {
    expect(buildMattermostAssignmentPayload({
      humanName: "Diego Ruiz",
      mattermostUsername: "diego",
      issueTitle: "Review payer integration",
      issueIdentifier: "RCM-42",
      issueUrl: "https://paperclip.example/RCM/issues/issue-42",
      priority: "high",
    })).toEqual(expect.objectContaining({
      text: expect.stringContaining("@diego"),
      props: expect.objectContaining({
        card: expect.stringContaining("Review payer integration"),
      }),
    }));

    const neutralized = buildMattermostAssignmentPayload({
      humanName: "@here coordinator",
      issueTitle: "Review with @channel",
      issueIdentifier: "RCM-43",
      issueUrl: "https://paperclip.example/RCM/issues/issue-43",
    });
    expect(neutralized.text).not.toContain("@here");
    expect(neutralized.text).not.toContain("@channel");
  });

  it("escapes imported Markdown syntax in Mattermost assignment payloads", () => {
    const payload = buildMattermostAssignmentPayload({
      humanName: "Asha Patel",
      mattermostUsername: "asha",
      issueTitle: "Review ](https://evil.example) @channel",
      issueIdentifier: "QI-42",
      issueUrl: "https://paperclip.example/issues/QI-42",
      priority: "high",
    });

    expect(payload.text).toContain("Review \\]\\(https://evil.example\\) @\u200Bchannel");
    expect(payload.text).not.toContain("Review ](https://evil.example)");
  });
});
