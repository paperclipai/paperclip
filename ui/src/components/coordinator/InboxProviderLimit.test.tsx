// @vitest-environment jsdom

import type { AttentionItem, AttentionProviderLimit } from "@paperclipai/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { InboxProviderLimit } from "./InboxProviderLimit";

vi.mock("@/lib/router", async () => ({ Link: (await import("react-router-dom")).Link }));

const resetAt = "2026-11-24T20:00:00Z";
const firstRetry = "2026-11-24T18:00:00Z";
const secondRetry = "2026-11-24T19:00:00Z";

function task(id: string, retryAt: string): AttentionItem {
  const providerLimit: AttentionProviderLimit = {
    episode: "account-window", grouping: "account_window", attempts: 1, state: "scheduled", resetAt, retryAt,
    runId: id, agentId: "editor", agentName: "Editor",
  };
  return {
    relatedIssue: { id, identifier: id, title: "Review the launch", href: `/issues/${id}` },
    providerLimit,
  } as AttentionItem;
}

describe("InboxProviderLimit", () => {
  it("distinguishes the reported reset and each task's scheduled retry time", () => {
    const html = renderToStaticMarkup(<MemoryRouter>
      <InboxProviderLimit item={task("IBX-1", firstRetry)} evidence={[task("IBX-2", secondRetry)]} />
    </MemoryRouter>);
    const container = document.createElement("div");
    container.innerHTML = html;
    const reset = Array.from(container.querySelectorAll("p")).find(row => row.textContent?.includes("Provider reset"));
    expect(reset?.querySelector("time")?.dateTime).toBe(resetAt);
    expect(Array.from(container.querySelectorAll("li"), row => row.querySelector("time")?.dateTime))
      .toEqual([firstRetry, secondRetry]);
  });
});
