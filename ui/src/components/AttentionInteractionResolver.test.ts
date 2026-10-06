// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import {
  failedSecretProposalInteraction,
  pendingSecretProposalInteraction,
} from "../fixtures/issueThreadInteractionFixtures";
import { AttentionInteractionResolver, replaceResolvedInteraction } from "./AttentionInteractionResolver";

const listInteractions = vi.hoisted(() => vi.fn());
vi.mock("@/api/issues", () => ({ issuesApi: { listInteractions: (issueId: string) => listInteractions(issueId) } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("replaceResolvedInteraction", () => {
  it("immediately replaces a pending secret proposal with its stitched failure receipt", () => {
    const resolved = {
      ...failedSecretProposalInteraction,
      id: pendingSecretProposalInteraction.id,
    };

    const next = replaceResolvedInteraction([pendingSecretProposalInteraction], resolved);

    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("accepted");
    expect(next[0]?.kind).toBe("request_confirmation");
    if (next[0]?.kind === "request_confirmation") {
      expect(next[0].result?.secretProposal).toMatchObject({
        status: "failed",
        errorCode: "binding_snapshot_stale",
      });
    }
  });

  it("retains the stitched receipt when the interaction cache was empty", () => {
    expect(replaceResolvedInteraction(undefined, failedSecretProposalInteraction)).toEqual([
      failedSecretProposalInteraction,
    ]);
  });
});

describe("AttentionInteractionResolver display localization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    listInteractions.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    await i18n.changeLanguage("en");
  });

  it.each(["loading", "missing", "error"] as const)("updates the %s state EN → RU → EN without changing IDs or refetching", async (state) => {
    if (state === "loading") listInteractions.mockImplementation(() => new Promise(() => {}));
    else if (state === "error") listInteractions.mockRejectedValue(new Error("Raw provider failure"));
    else listInteractions.mockResolvedValue([]);
    const onResolved = vi.fn();
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(AttentionInteractionResolver, {
        companyId: "raw-company-1", issueId: "raw-issue-2", interactionId: "raw-interaction-3", onResolved,
      })));
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const message = container.firstElementChild;
    const query = client.getQueryCache().find({ queryKey: queryKeys.issues.interactions("raw-issue-2") });
    expect(message).not.toBeNull();
    expect(query).toBeDefined();
    for (const [locale, loading, unavailable] of [
      ["en", "Loading decision…", "This decision is no longer available — it may have been resolved elsewhere."],
      ["ru", "Загружаем запрос, по которому нужно принять решение…", "Запрос больше недоступен. Возможно, решение по нему уже приняли в другом месте."],
      ["en", "Loading decision…", "This decision is no longer available — it may have been resolved elsewhere."],
    ] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.firstElementChild).toBe(message);
      expect(message?.textContent?.trim()).toBe(state === "loading" ? loading : unavailable);
      expect(listInteractions).toHaveBeenCalledExactlyOnceWith("raw-issue-2");
      expect(client.getQueryCache().find({ queryKey: queryKeys.issues.interactions("raw-issue-2") })).toBe(query);
      expect(onResolved).not.toHaveBeenCalled();
      expect(client.getMutationCache().getAll()).toHaveLength(0);
    }
  });
});
