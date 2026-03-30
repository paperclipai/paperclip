import { describe, expect, it } from "vitest";
import {
  canRegisterPluginRuntimeProfiles,
  normalizePluginRuntimeProfiles,
} from "./plugin-loader.js";

describe("normalizePluginRuntimeProfiles", () => {
  it("keeps valid declarations and trims values", () => {
    const result = normalizePluginRuntimeProfiles([
      {
        id: "  http+crewai  ",
        label: "  HTTP + CrewAI ",
        framework: " CrewAI ",
        defaultHeaderValue: " CrewAI ",
        description: " Crew profile ",
      },
    ]);

    expect(result).toEqual([
      {
        id: "http+crewai",
        label: "HTTP + CrewAI",
        framework: "CrewAI",
        defaultHeaderValue: "CrewAI",
        description: "Crew profile",
      },
    ]);
  });

  it("drops malformed declarations", () => {
    const result = normalizePluginRuntimeProfiles([
      { id: "", label: "bad", framework: "CrewAI" },
      { id: "http+ok", label: "", framework: "CrewAI" },
      { id: "http+ok", label: "OK", framework: "" },
    ] as any);

    expect(result).toEqual([]);
  });

  it("requires runtime.profiles.register capability for startup registration", () => {
    expect(
      canRegisterPluginRuntimeProfiles({
        id: "acme.test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Test",
        description: "test",
        author: "test",
        categories: ["connector"],
        capabilities: ["runtime.profiles.register"],
        entrypoints: { worker: "dist/worker.js" },
      }),
    ).toBe(true);
    expect(
      canRegisterPluginRuntimeProfiles({
        id: "acme.test",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Test",
        description: "test",
        author: "test",
        categories: ["connector"],
        capabilities: ["companies.read"],
        entrypoints: { worker: "dist/worker.js" },
      }),
    ).toBe(false);
  });
});
