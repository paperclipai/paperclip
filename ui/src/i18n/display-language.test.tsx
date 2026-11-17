// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { IssueStatusBadge } from "../components/StatusBadge";
import { getStatusIconLabel } from "../components/StatusIcon";
import { formatStoppedAge } from "../lib/blockedInbox";
import { relativeTime } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { DISPLAY_LOCALE_STORAGE_KEY, displayText, getDisplayLocale, initDisplayLanguage } from "./display-text";
import { i18n } from "./index";

describe("initDisplayLanguage with a saved French choice", () => {
  afterAll(async () => {
    vi.restoreAllMocks();
    localStorage.removeItem(DISPLAY_LOCALE_STORAGE_KEY);
    await i18n.changeLanguage("en");
  });

  it("loads the French catalog and translates computed labels", async () => {
    localStorage.setItem(DISPLAY_LOCALE_STORAGE_KEY, "fr");
    await expect(initDisplayLanguage()).resolves.toBe("fr");
    expect(getDisplayLocale()).toBe("fr");
    expect(i18n.language).toBe("fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(displayText("Password")).toBe("Mot de passe");
    expect(displayText("Plan with {{v0}}…", { v0: "Ada" })).toBe("Planifier avec Ada…");
    expect(renderToStaticMarkup(<IssueStatusBadge status="in_progress" />)).toContain("En cours");
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-29T12:00:00Z"));
    expect(timeAgo("2026-10-29T11:58:00Z")).toBe("il y a 2 min");
    expect(formatStoppedAge("2026-10-29T11:30:00Z")).toBe("arrêté depuis 30 min");
    expect(relativeTime("2026-10-29T11:55:00Z")).toBe("il y a 5 min");
    expect(displayText("{{v0}} {{v1}}", { v0: "Enable", v1: "agentmail" })).toBe("Activer agentmail");
    expect(formatStoppedAge("2026-10-27T12:00:00Z")).toBe("arrêté depuis 2 j");
    const attention = {
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 2,
      sampleBlockerIdentifier: null,
      sampleStalledBlockerIdentifier: null,
    } as const;
    expect(getStatusIconLabel("blocked", null, attention)).toBe("Bloqué · 2 blocages nécessitent une intervention");
    expect(getStatusIconLabel("blocked", null, { ...attention, coveredBlockerCount: 1 })).toBe(
      "Bloqué · 2 blocages nécessitent une intervention ; 1 couvert(s) par un travail en cours",
    );
    expect(getStatusIconLabel("blocked")).toBe("Bloqué");
  });
});
