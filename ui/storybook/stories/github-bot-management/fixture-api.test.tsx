// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FixtureApi } from "./fixture-api";
import { endpoint, reviews } from "./fixtures";

vi.mock("@/context/EditorAutocompleteContext", () => ({
  EditorAutocompleteProvider: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => vi.restoreAllMocks());

it("serves a review detail to the routed preview and rejects unknown review IDs", async () => {
  vi.spyOn(window, "fetch").mockResolvedValue(Response.json({}));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<FixtureApi><span>Ready</span></FixtureApi>));
    const path = `/api/chat-endpoints/${endpoint.id}/github/reviews/`;
    const response = await window.fetch(path + reviews[0].id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: reviews[0].id, headSha: reviews[0].headSha,
    });
    expect((await window.fetch(path + "missing-review")).status).toBe(404);
  } finally {
    flushSync(() => root.unmount());
  }
});
