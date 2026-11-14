import { describe, expect, it, vi } from "vitest";
import { reopenTaskDocument } from "./task-document-flow.js";
import type { JourneyContext } from "./types.js";

describe("task document reopen navigation", () => {
  it.each(["done", "mine"])("finds the backlog task instead of inheriting the saved %s view", async savedView => {
    const issue = { title: "Journey QA task document" };
    let view = savedView;
    let search = "";
    const click = vi.fn(async () => {
      if (view !== "backlog" || search !== issue.title) throw new Error("Owned backlog task is not in this task list");
    });
    const reload = vi.fn();
    const context = {
      api: { origin: "https://qa.example.test" }, company: { issuePrefix: "QA" },
      page: {
        goto: vi.fn(async (url: string) => {
          const params = new URL(url).searchParams;
          view = params.get("view") ?? savedView;
          search = params.get("q") ?? "";
        }),
        reload,
        getByRole: (role: string) => role === "link"
          ? { filter: ({ hasText }: { hasText: string }) => {
            expect(hasText).toBe(issue.title);
            return { first: () => ({ click }) };
          } }
          : { isVisible: async () => true, first: () => ({ isVisible: async () => true }) },
      },
    } as unknown as JourneyContext;
    await reopenTaskDocument(context, issue);
    expect(click).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });
});
