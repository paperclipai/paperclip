import { expect, it, vi } from "vitest";
import { parseSearchQuery } from "../lib/search-query-parser";
import { searchApi } from "./search";
import { api } from "./client";

vi.mock("./client", () => ({ api: { get: vi.fn() } }));

it("keeps scheduled monitor waits in is:open search requests", async () => {
  const parsed = parseSearchQuery("is:open deployment", {});
  await searchApi.search("company-1", { q: parsed.query, ...parsed.filters });
  const url = new URL(vi.mocked(api.get).mock.calls[0]![0], "http://localhost");
  expect(url.searchParams.getAll("displayStatus")).toEqual(["backlog", "todo", "in_progress", "monitoring", "in_review", "blocked"]);
  expect(url.searchParams.get("q")).toBe("deployment");
});
