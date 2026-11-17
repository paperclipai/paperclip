// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installFixtureApi,
  prepareFixtureApi,
  activatePreparedFixtures,
} from "./api";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
describe("capability story API boundary", () => {
  it("activates story routes after preview defaults and restores those defaults", async () => {
    const preview = vi.fn(async () => Response.json({ source: "preview" }));
    const fixture = prepareFixtureApi([
      { path: "/api/subject", read: () => ({ source: "story" }) },
    ]);
    cleanup = fixture.cleanup;
    vi.stubGlobal("fetch", preview);
    activatePreparedFixtures();
    expect(await (await window.fetch("/api/subject")).json()).toEqual({
      source: "story",
    });
    expect(await (await window.fetch("/api/other")).json()).toEqual({
      source: "preview",
    });
    fixture.cleanup();
    cleanup = undefined;
    expect(window.fetch).toBe(preview);
  });
  it("blocks an unregistered mutation without calling the outer fetch", async () => {
    const outer = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(Response.json({ unexpected: true }));
    cleanup = installFixtureApi([]).cleanup;
    const reply = await window.fetch("/api/companies/company-storybook", {
      method: "PATCH",
      body: "{}",
    });
    expect(reply.status).toBe(501);
    expect(outer).not.toHaveBeenCalled();
  });
  it("parses Request bodies and records the mutation before a simulated denial", async () => {
    const handler = vi.fn(() => ({ saved: true }));
    const fixture = installFixtureApi(
      [{ path: "/api/example", method: "POST", read: handler }],
      "mutation-permission",
    );
    cleanup = fixture.cleanup;
    const result = await window.fetch(
      new Request(`${location.origin}/api/example`, {
        method: "POST",
        body: JSON.stringify({ value: 42 }),
      }),
    );
    expect(result.status).toBe(403);
    expect(fixture.requests[0].body).toEqual({ value: 42 });
    expect(handler).not.toHaveBeenCalled();
  });
  it("keeps prerequisite flags available during a subject error and restores fetch and company selection", async () => {
    const previous = window.fetch;
    localStorage.setItem("paperclip.selectedCompanyId", "original-company");
    const fixture = installFixtureApi(
      [
        { path: "/api/flags", state: "ready", read: () => ({ enabled: true }) },
        { path: "/api/subject", read: () => [] },
      ],
      "failure",
    );
    cleanup = fixture.cleanup;
    expect(await (await window.fetch("/api/flags")).json()).toEqual({
      enabled: true,
    });
    expect((await window.fetch("/api/subject")).status).toBe(500);
    fixture.cleanup();
    cleanup = undefined;
    expect(window.fetch).toBe(previous);
    expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe(
      "original-company",
    );
  });
});
