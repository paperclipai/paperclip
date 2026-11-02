// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { ActivityRow } from "./ActivityRow";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ActivityRow author-name provenance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it.each([null, "Board", "You", "Me"])("keeps real author %s distinct from the generated Board label EN → RU → EN", async (name) => {
    const profiles = buildCompanyUserProfileMap([{
      principalId: "local-board", status: "active",
      user: name ? { id: "local-board", name, email: null, image: null } : null,
    }]);
    const event: ActivityEvent = {
      id: "raw-event-1", companyId: "raw-company-1", actorType: "user", actorId: "local-board",
      action: "issue.created", entityType: "issue", entityId: "raw-issue-1", agentId: null,
      runId: null, details: null, createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const original = JSON.stringify({ event, profiles: [...profiles] });
    await act(async () => root.render(<ActivityRow event={event} agentMap={new Map()} userProfileMap={profiles} entityNameMap={new Map([["issue:raw-issue-1", "PAP-123"]])} />));
    const link = container.querySelector("a")!;
    for (const locale of ["en", "ru", "en"] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector("a")).toBe(link);
      expect(link.getAttribute("href")).toBe("/issues/PAP-123");
      // Trans may rebuild its inline nodes when sentence punctuation changes;
      // the enclosing row/link must remain stable.
      expect(link.querySelector("p > span > span")?.textContent, link.innerHTML).toBe(name ?? (locale === "ru" ? "Руководство" : "Board"));
      expect(JSON.stringify({ event, profiles: [...profiles] })).toBe(original);
      expect(profiles.get("local-board")?.label).toBe(name ?? "Board");
    }
  });
});
