import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRepoFile(path: string) {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
}

describe("release-content Cases contract", () => {
  it("keeps release-content skills wired to emit the required case tree", () => {
    const release = readRepoFile(".agents/skills/release/SKILL.md");
    const changelog = readRepoFile(".agents/skills/release-changelog/SKILL.md");
    const discord = readRepoFile(".agents/skills/release-changelog-discord-message/SKILL.md");
    const announcement = readRepoFile("packages/skills-catalog/catalog/optional/content/release-announcement/SKILL.md");
    const combined = [release, changelog, discord, announcement].join("\n");

    for (const required of [
      "\"caseType\": \"release\"",
      "\"caseType\": \"blog_post\"",
      "\"caseType\": \"tweet_storm\"",
      "\"parentCaseId\"",
      "PUT /api/cases/:caseId/documents/body",
      "paperclip-release:vYYYY.MDD.P",
      "X-Paperclip-Run-Id",
    ]) {
      expect(combined).toContain(required);
    }

    expect(release).toContain("same three cases instead of duplicating them");
    expect(changelog).toContain("\"release_patch\": 0");
    expect(changelog).toContain("\"stable\": true");
    expect(changelog).toContain("\"channels\": [\"changelog\", \"blog_post\", \"tweet_storm\"]");
    expect(changelog).toContain("\"artifacts\"");
    expect(changelog).toContain("\"verification\"");
    expect(changelog).toContain("\"notes\": null");
    expect(announcement).toContain("\"word_count_target\": 650");
    expect(announcement).toContain("\"requires_screenshot\": false");
    expect(discord).toContain("\"needs_human_copy_paste\": true");
    expect(discord).toContain("\"approved_by\": null");
  });
});
