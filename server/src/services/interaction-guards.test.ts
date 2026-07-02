import { describe, expect, it } from "vitest";
import {
  extractGithubRepositoryLocators,
  findMismatchedConfirmationRepositories,
  isMergeRequestConfirmationContent,
  normalizeRepositoryLocator,
} from "./interaction-guards.js";

describe("interaction guards", () => {
  it("normalizes GitHub repository URLs", () => {
    expect(normalizeRepositoryLocator("https://github.com/Dream38pt/paperclip.git")).toBe("github.com/dream38pt/paperclip");
    expect(normalizeRepositoryLocator("git@github.com:Dream38pt/paperclip.git")).toBe("github.com/dream38pt/paperclip");
  });

  it("extracts GitHub repositories from PR markdown", () => {
    expect(extractGithubRepositoryLocators("PR: https://github.com/Dream38pt/usine-dev-sandbox/pull/5")).toEqual([
      "github.com/dream38pt/usine-dev-sandbox",
    ]);
  });

  it("detects merge confirmations", () => {
    expect(isMergeRequestConfirmationContent({
      title: "USI-56 — Livraison prête, merge ?",
      payload: { acceptLabel: "Merger la PR" },
    })).toBe(true);
  });

  it("flags PR confirmations targeting the wrong repository", () => {
    expect(findMismatchedConfirmationRepositories({
      title: "USI-56 — Livraison prête, merge ?",
      payload: {
        acceptLabel: "Merger la PR",
        detailsMarkdown: "[PR #5](https://github.com/Dream38pt/usine-dev-sandbox/pull/5)",
      },
      expectedRepoUrl: "https://github.com/Dream38pt/paperclip.git",
    })).toEqual(["github.com/dream38pt/usine-dev-sandbox"]);
  });
});
