import { describe, expect, it } from "vitest";
import { announcementManifestSchema, isAnnouncementEligible } from "../../packages/shared/src/announcements.js";
import { runnerExecutionById } from "./catalog.js";
import { CHAT_ANNOUNCEMENT_FEED_URL, CHAT_ANNOUNCEMENT_MANIFEST, CHAT_ANNOUNCEMENT_SCENARIO } from "./chat-announcement-fixture.js";
import { buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
import { navigationBoundaryIdentityCases } from "./chat-catalog-domains/identity-navigation-boundaries.js";

describe("singleton announcement fixture admission", () => {
  const selected = runnerExecutionById(`chat-features.runner-opencode.local.${CHAT_ANNOUNCEMENT_SCENARIO}`);
  const unrelated = runnerExecutionById("chat-features.runner-opencode.local.skills.author-skill");
  it("the actual process and server boundaries admit only the selected public staging feed", () => {
    const source = { PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false", PAPERCLIP_ANNOUNCEMENTS_FEED_URL: "https://ambient.invalid/private-feed" };
    const process = buildRunnerE2EProcessEnvironment(source, [selected]);
    const server = buildPaperclipServerEnvironment(process);
    expect(server.PAPERCLIP_ANNOUNCEMENTS_ENABLED).toBe("true");
    expect(server.PAPERCLIP_ANNOUNCEMENTS_FEED_URL).toBe(CHAT_ANNOUNCEMENT_FEED_URL);
    expect(source.PAPERCLIP_ANNOUNCEMENTS_FEED_URL).toBe("https://ambient.invalid/private-feed");
    const url = new URL(server.PAPERCLIP_ANNOUNCEMENTS_FEED_URL!);
    expect(url.protocol).toBe("https:"); expect(url.username + url.password + url.search + url.hash).toBe("");
    expect(url.pathname).toContain("/announcements/staging/chat-dismissal-eval-");
    expect(url.pathname).not.toBe("/announcements/v1/current.json");
  });
  it.each(["unrelated", "mixed", "empty", "wrong suite"])("keeps announcements disabled for %s selections", selection => {
    const executions = selection === "unrelated" ? [unrelated] : selection === "mixed" ? [selected, unrelated] : selection === "wrong suite" ? [{ ...selected, suite: { ...selected.suite, id: "other" } }] : [];
    const process = buildRunnerE2EProcessEnvironment({ PAPERCLIP_ANNOUNCEMENTS_ENABLED: "true" }, executions);
    expect(buildPaperclipServerEnvironment(process).PAPERCLIP_ANNOUNCEMENTS_ENABLED).toBe("false");
  });
  it("uses a valid public synthetic publication without expiry or product-version tricks", () => {
    const manifest = announcementManifestSchema.parse(CHAT_ANNOUNCEMENT_MANIFEST);
    expect(manifest.announcement).not.toBeNull();
    expect(isAnnouncementEligible(manifest.announcement!, "2026.1017.0", Date.parse("2026-11-03T00:00:00Z"))).toBe(true);
    expect(manifest.announcement).not.toHaveProperty("minimumPaperclipVersion");
    expect(manifest.announcement).not.toHaveProperty("expiresAt");
    expect(manifest.announcement!.primaryAction).toEqual({ kind: "route", label: "Explore your projects", path: "/projects" });
  });
  it.each(["missing", "wrong id", "wrong title", "exact publication"])("the real setup checks %s before any model or human dismissal", async kind => {
    const publication: { id: string; title: string } = { ...CHAT_ANNOUNCEMENT_MANIFEST.announcement };
    if (kind === "wrong id") publication.id = "foreign-notice";
    if (kind === "wrong title") publication.title = "Foreign title";
    const ctx = { input: { api: { get: async (path: string) => {
      if (path === "/api/announcements/current") return kind === "missing" ? null : publication;
      throw new Error("AFTER_EXPECTED_PUBLICATION");
    } } } } as unknown as ChatCatalogContext;
    const setup = navigationBoundaryIdentityCases.find(row => row.scenarioId === CHAT_ANNOUNCEMENT_SCENARIO)!.setup(ctx);
    await expect(setup).rejects.toThrow(kind === "missing" ? "real eligible server announcement" : kind === "exact publication" ? "AFTER_EXPECTED_PUBLICATION" : "owned staging announcement");
  });
});
