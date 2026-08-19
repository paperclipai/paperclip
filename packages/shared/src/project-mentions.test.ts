import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
  extractAgentMentionIds,
  extractBareAgentMentionIds,
  extractProjectMentionIds,
  extractRoutineMentionIds,
  extractSkillMentionIds,
  extractUserMentionIds,
  parseAgentMentionHref,
  parseProjectMentionHref,
  parseRoutineMentionHref,
  parseSkillMentionHref,
  parseUserMentionHref,
} from "./project-mentions.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Paperclip App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
  });

  it("resolves unique bare agent handles by display name or URL key", () => {
    const agents = [
      { id: "agent-ops", name: "Ops Sol" },
      { id: "agent-review", name: "Review_Agent" },
    ];

    expect(extractBareAgentMentionIds("Please ask @ops-sol.", agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds('Please ask "@ops-sol".', agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("Please ask **@ops-sol**.", agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("Please ask *@ops-sol*.", agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("Please ask _@ops-sol_.", agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("Please ask ~~@ops-sol~~.", agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("Please ask —@ops-sol。", agents)).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("@review_agent then @review-agent", agents)).toEqual([
      "agent-review",
    ]);
  });

  it("rejects ambiguous bare agent handles", () => {
    expect(extractBareAgentMentionIds("Ask @ops-sol", [
      { id: "agent-1", name: "Ops Sol" },
      { id: "agent-2", name: "ops-sol" },
    ])).toEqual([]);
  });

  it("ignores bare-handle lookalikes in email, URL, and Markdown code contexts", () => {
    const agents = [{ id: "agent-ops", name: "Ops Sol" }];
    const ignoredBodies = [
      "ops@example.com and 用户@ops-sol.example",
      "foo+@ops-sol and mailto:foo+@ops-sol",
      "foo!@ops-sol and foo!#$%&'*+-/=?^_`{|}~@ops-sol",
      "!@ops-sol *@ops-sol _@ops-sol ~@ops-sol",
      "~~~@ops-sol~~~ and foo_@ops-sol_",
      "https://example.com/@ops-sol ftp://example.com/@ops-sol www.example.com/@ops-sol",
      "data:text/plain,@ops-sol and urn:example:x,@ops-sol",
      "/teams/@ops-sol",
      "\\@ops-sol",
      "npm install @ops-sol/package and @ops-sol/path",
      "[docs](custom:@ops-sol) and [@ops-sol](user://user-1)",
      "[docs](https://host/x(y)@ops-sol)",
      "[docs](/url \"note ) @ops-sol\")",
      "[@ops-sol][ref]\n\n[ref]: https://example.com",
      "\\\\[@ops-sol][ref]",
      "![@ops-sol][image-ref]\n\n[image-ref]: https://example.com/image.png",
      "[x]: custom:@ops-sol",
      "[multiline-ref]:\n@ops-sol",
      "[multiline-title]: /url \"title\n@ops-sol\"",
      "[ref\\]]: @ops-sol",
      "> [ref]: @ops-sol",
      "> > [nested-ref]: @ops-sol",
      "- [list-ref]: @ops-sol",
      "custom:@ops-sol and @ops-sol.example",
      "@ops-sol.例",
      "<a href=\"@ops-sol\">docs</a>",
      "<a href=\"x>y@ops-sol\">docs</a>",
      "<a href=x @ops-sol",
      "<script>@ops-sol</script>",
      "<script data-example=\">\">@ops-sol</script>",
      "<script data-example=\"</script>\">@ops-sol</script>",
      "<script>\n</scripture>\n@ops-sol\n</script>",
      "<style>body::before { content: '@ops-sol'; }</style>",
      "<!--\n@ops-sol\n-->",
      "<a\n href=\"@ops-sol\">docs</a>",
      "`@ops-sol`",
      "``inline\n@ops-sol``",
      "```text\n@ops-sol\n```",
      "prefix ```text\n@ops-sol\n``` suffix",
      "> ```text\n> @ops-sol\n> ```",
      "    @ops-sol",
      "\t@ops-sol",
      ">     @ops-sol",
      "-     @ops-sol",
      "<code>@ops-sol</code>",
      "<pre>@ops-sol</pre>",
    ];

    for (const body of ignoredBodies) {
      expect(extractBareAgentMentionIds(body, agents), body).toEqual([]);
    }
    expect(extractBareAgentMentionIds("\\[@ops-sol][ref]\n\n[ref]: /url", agents))
      .toEqual(["agent-ops"]);
    for (const hiddenHtml of [
      "<script>@ops-sol</script>",
      "<style>body::before { content: '@ops-sol'; }</style>",
      "<!--\n@ops-sol\n-->",
      "<a\n href=\"@ops-sol\">docs</a>",
    ]) {
      expect(extractBareAgentMentionIds(hiddenHtml, agents)).toEqual([]);
    }
    expect(extractBareAgentMentionIds(
      "[docs](https://host/x(y)) then @ops-sol",
      agents,
    )).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds(
      "[docs](https://example.com/O'Reilly) then @ops-sol",
      agents,
    )).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds(
      '<span title="C:\\">@ops-sol</span>',
      agents,
    )).toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("```text\n@ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("~~~text\n@ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("- ```text\n  @ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("- ~~~text\n  @ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("- > ```text\n  > @ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("> - ~~~text\n>   @ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("```text\n```not-a-close\n@ops-sol\n```", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("~~~text\n~~~not-a-close\n@ops-sol\n~~~", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("> ```text\n> > ```\n> @ops-sol\n> ```", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("> ```text\n> hidden\n> ```\n@ops-sol", agents))
      .toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("- ```text\n  hidden\n  ```\n@ops-sol", agents))
      .toEqual(["agent-ops"]);
    expect(extractBareAgentMentionIds("```text\r\n@ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds("```text\r@ops-sol", agents)).toEqual([]);
    expect(extractBareAgentMentionIds(
      "@12345678-1234-4123-8123-123456789abc",
      [{ id: "12345678-1234-4123-8123-123456789abc", name: "审查员" }],
    )).toEqual(["12345678-1234-4123-8123-123456789abc"]);
  });

  it("round-trips user mentions", () => {
    const href = buildUserMentionHref("user-123");
    expect(parseUserMentionHref(href)).toEqual({
      userId: "user-123",
    });
    expect(extractUserMentionIds(`[@Taylor](${href})`)).toEqual(["user-123"]);
  });

  it("round-trips skill mentions with slug metadata", () => {
    const href = buildSkillMentionHref("skill-123", "release-changelog");
    expect(parseSkillMentionHref(href)).toEqual({
      skillId: "skill-123",
      slug: "release-changelog",
    });
    expect(extractSkillMentionIds(`[/release-changelog](${href})`)).toEqual(["skill-123"]);
  });

  it("round-trips routine mentions", () => {
    const href = buildRoutineMentionHref("routine-123");
    expect(parseRoutineMentionHref(href)).toEqual({
      routineId: "routine-123",
    });
    expect(extractRoutineMentionIds(`[/routine:Weekly review](${href})`)).toEqual(["routine-123"]);
  });
});
