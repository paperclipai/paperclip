// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { GUIDANCE_COMPANY, GUIDANCE_CONNECTION, installConnectionGuidanceFixtures } from "../../../storybook/fixtures/connectionInstructions";

afterEach(() => vi.unstubAllGlobals());

it("keeps the directory and unimplemented connector requests inside the preview", async () => {
  const fallback = vi.fn().mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", fallback);
  const client = new QueryClient();
  const cleanup = installConnectionGuidanceFixtures(client, "Honcho", { setup: false, askFirst: false });
  try {
    const directory = await window.fetch(`/api/companies/${GUIDANCE_COMPANY}/user-directory`);
    expect((await directory.json()).users[0].user.name).toBe("Riley Board");
    const unknownOperation = await window.fetch(`/api/companies/${GUIDANCE_COMPANY}/tools/unsupported-operation`, { method: "POST" });
    expect(unknownOperation.status).toBe(422);
    const providerTest = await window.fetch(`/api/tool-connections/${GUIDANCE_CONNECTION}/test-action`, { method: "POST" });
    expect(providerTest.status).toBe(422);
    const oauth = await window.fetch("/api/tools/oauth/start", { method: "POST" });
    expect(oauth.status).toBe(422);
    expect(fallback).not.toHaveBeenCalled();
  } finally {
    cleanup();
    client.clear();
  }
  expect(window.fetch).toBe(fallback);
});
