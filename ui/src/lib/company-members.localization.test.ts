import { afterEach, describe, expect, it } from "vitest";
import type { CompanyUserDirectoryEntry } from "@/api/access";
import { i18n } from "@/i18n";
import {
  buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserMentionOptions,
  buildCompanyUserProfileMap, companyUserLabelDisplayLabel, companyUserProfileDisplayLabel,
  isGeneratedCompanyUserLabel,
} from "./company-members";
import { formatUserDisplayLabel, formatUserLabel } from "./assignees";
import { buildIssueChatMessages, type IssueChatComment } from "./issue-chat-messages";
import { commentsToTaskChatItems } from "@/components/task-chat/task-chat-adapter";
import { formatActivityVerb } from "./activity-format";

function member(name: string | null = null, email: string | null = null): CompanyUserDirectoryEntry {
  return {
    principalId: "local-board", status: "active",
    user: name === null && email === null ? null : { id: "local-board", name, email, image: "/raw/avatar.png" },
  };
}

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("company member fallback provenance", () => {
  it.each([member(), member(" \t ", " \n ")])("localizes only a generated fallback and leaves canonical enumerable shapes unchanged: %j", async (entry) => {
    const labels = buildCompanyUserLabelMap([entry]);
    const profiles = buildCompanyUserProfileMap([entry]);
    const profile = profiles.get("local-board")!;
    const canonical = JSON.stringify({ labels: [...labels], profiles: [...profiles] });
    for (const [locale, display] of [["en", "Board"], ["ru", "Руководство"], ["en", "Board"]] as const) {
      await i18n.changeLanguage(locale);
      expect(companyUserLabelDisplayLabel("local-board", labels)).toBe(display);
      expect(companyUserProfileDisplayLabel(profile)).toBe(display);
      expect(formatUserDisplayLabel("local-board", labels)).toBe(display);
      expect(isGeneratedCompanyUserLabel("local-board", labels)).toBe(true);
      expect(formatUserLabel("local-board", labels)).toBe("Board");
      expect(labels.get("local-board")).toBe("Board");
      expect(profile.label).toBe("Board");
      expect(Object.keys(profile)).toEqual(["label", "image"]);
      expect(Object.getOwnPropertySymbols(profile)).toEqual([]);
      expect(Object.keys(labels)).toEqual([]);
      expect(Object.getOwnPropertySymbols(labels)).toEqual([]);
      expect(JSON.stringify({ labels: [...labels], profiles: [...profiles] })).toBe(canonical);
    }
  });

  it.each(["Board", "You", "Me"])("preserves the actual name %s, including a local-board user", async (name) => {
    const labels = buildCompanyUserLabelMap([member(` ${name} `)]);
    const profile = buildCompanyUserProfileMap([member(` ${name} `)]).get("local-board")!;
    for (const locale of ["en", "ru", "en"] as const) {
      await i18n.changeLanguage(locale);
      expect(companyUserLabelDisplayLabel("local-board", labels)).toBe(name);
      expect(companyUserProfileDisplayLabel(profile)).toBe(name);
      expect(formatUserDisplayLabel("local-board", labels)).toBe(name);
      expect(isGeneratedCompanyUserLabel("local-board", labels)).toBe(false);
      expect(profile.image).toBe("/raw/avatar.png");
    }
  });

  it("uses nonblank email as explicit identity and never translates an unmarked copied map/profile", async () => {
    const labels = buildCompanyUserLabelMap([member()]);
    const profile = buildCompanyUserProfileMap([member()]).get("local-board")!;
    const copiedLabels = new Map(labels);
    const copiedRecord = Object.fromEntries(labels);
    const copiedProfile = { ...profile };
    await i18n.changeLanguage("ru");
    expect(companyUserLabelDisplayLabel("local-board", labels)).toBe("Руководство");
    for (const copy of [copiedLabels, copiedRecord]) {
      expect(companyUserLabelDisplayLabel("local-board", copy)).toBe("Board");
      expect(formatUserDisplayLabel("local-board", copy)).toBe("Board");
      expect(isGeneratedCompanyUserLabel("local-board", copy)).toBe(false);
    }
    expect(companyUserProfileDisplayLabel(copiedProfile)).toBe("Board");
    const email = member(" ", " Board ");
    expect(companyUserProfileDisplayLabel(buildCompanyUserProfileMap([email]).get("local-board"))).toBe("Board");
    expect(formatUserDisplayLabel("local-board", buildCompanyUserLabelMap([email]))).toBe("Board");
  });

  it.each([false, true])("keeps provenance aligned with last-write-wins duplicate members (fallback last: %s)", async (fallbackLast) => {
    const entries = fallbackLast ? [member("Board"), member()] : [member(), member("Board")];
    const labels = buildCompanyUserLabelMap(entries);
    const profile = buildCompanyUserProfileMap(entries).get("local-board");
    await i18n.changeLanguage("ru");
    expect(companyUserLabelDisplayLabel("local-board", labels)).toBe(fallbackLast ? "Руководство" : "Board");
    expect(companyUserProfileDisplayLabel(profile)).toBe(fallbackLast ? "Руководство" : "Board");
    expect(labels.get("local-board")).toBe("Board");
    expect(profile?.label).toBe("Board");
  });

  it("does not apply stale provenance to a label changed after construction", async () => {
    const labels = buildCompanyUserLabelMap([member()]);
    const profile = buildCompanyUserProfileMap([member()]).get("local-board")!;
    labels.set("local-board", "Raw replacement");
    profile.label = "You";
    await i18n.changeLanguage("ru");
    expect(companyUserLabelDisplayLabel("local-board", labels)).toBe("Raw replacement");
    expect(companyUserProfileDisplayLabel(profile)).toBe("You");
  });

  it("keeps generated names canonical in mention options and both message assemblers", async () => {
    const entries = [member()];
    const labels = buildCompanyUserLabelMap(entries);
    const comment: IssueChatComment = {
      id: "raw-comment-1", companyId: "raw-company-1", issueId: "raw-issue-1",
      authorAgentId: null, authorUserId: "local-board", authorType: "user",
      body: "Do not translate this message", presentation: null, metadata: null, sourceTrust: null,
      createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const build = () => ({
      mentions: buildCompanyUserMentionOptions(entries),
      inline: buildCompanyUserInlineOptions(entries),
      messages: buildIssueChatMessages({ comments: [comment], timelineEvents: [], linkedRuns: [], liveRuns: [], userLabelMap: labels }),
      items: commentsToTaskChatItems([comment], { userLabelMap: labels }),
    });
    await i18n.changeLanguage("en");
    const expected = JSON.stringify(build());
    for (const locale of ["ru", "en"] as const) {
      await i18n.changeLanguage(locale);
      expect(JSON.stringify(build())).toBe(expected);
      expect(build().mentions[0].name).toBe("Board");
      expect(build().inline[0].label).toBe("Board");
      expect(build().messages[0].metadata.custom.authorName).toBe("Board");
      expect(JSON.stringify(build())).not.toContain("Руководство");
      expect(comment.body).toBe("Do not translate this message");
    }
  });

  it.each([null, "Board", "You", "Me"])("uses provenance in activity participant text without rewriting actual name %s", async (name) => {
    const profiles = buildCompanyUserProfileMap([member(name)]);
    const details = { addedParticipants: [{ type: "user", userId: "local-board" }], removedParticipants: [] };
    const original = JSON.stringify(details);
    for (const locale of ["en", "ru", "en"] as const) {
      await i18n.changeLanguage(locale);
      const label = name ?? (locale === "ru" ? "Руководство" : "Board");
      expect(formatActivityVerb("issue.reviewers_updated", details, { userProfileMap: profiles })).toBe(locale === "ru"
        ? `добавление проверяющего: ${label}` : `added reviewer ${label} to`);
      expect(JSON.stringify(details)).toBe(original);
    }
  });
});
