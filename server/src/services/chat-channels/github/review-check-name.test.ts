import { describe, expect, it } from "vitest";
import { findGitHubReviewCheck, githubReviewCheckName } from "./review-check-name.js";

describe("GitHub review check name", () => {
  it("names the check after the GitHub App", () => {
    expect(githubReviewCheckName({ botDisplayName: "Ponytail Bottybois Review", botUsername: "ponytail-bottybois-review[bot]" }))
      .toBe("Ponytail Bottybois Review");
  });
  it("falls back to the bot login, then the legacy name, for older connections", () => {
    expect(githubReviewCheckName({ botDisplayName: null, botUsername: "ponytail[bot]" })).toBe("ponytail");
    expect(githubReviewCheckName({ botDisplayName: " ", botUsername: null })).toBe("Paperclip Review");
  });
  it("keeps the name on one line", () => {
    expect(githubReviewCheckName({ botDisplayName: "Review\r\nBot", botUsername: null })).toBe("Review Bot");
  });
});

describe("GitHub review check lookup", () => {
  const mine = { id: 1, external_id: "endpoint:7:abc", app: { id: 5566481 } };
  const peer = { id: 2, external_id: "endpoint:7:abc", app: { id: 5594216 } };
  const input = { headSha: "abc", externalId: "endpoint:7:abc", appId: "5566481", name: "QA Review" };
  function fakeRequest(byName: Record<string, Array<typeof mine>>) {
    const names: string[] = [];
    const request = async (path: string) => {
      const name = decodeURIComponent(/check_name=([^&]+)/.exec(path)![1]);
      names.push(name);
      return { check_runs: byName[name] ?? [] };
    };
    return { request, names };
  }

  it("matches this App's check under the App name without a legacy lookup", async () => {
    const api = fakeRequest({ "QA Review": [peer, mine] });
    await expect(findGitHubReviewCheck(api.request, input)).resolves.toBe(mine);
    expect(api.names).toEqual(["QA Review"]);
  });
  it("finds a check published under the legacy name so the update renames it", async () => {
    const api = fakeRequest({ "Paperclip Review": [peer, mine] });
    await expect(findGitHubReviewCheck(api.request, input)).resolves.toBe(mine);
    expect(api.names).toEqual(["QA Review", "Paperclip Review"]);
  });
  it("never adopts another App's check", async () => {
    const api = fakeRequest({ "QA Review": [peer], "Paperclip Review": [peer] });
    await expect(findGitHubReviewCheck(api.request, input)).resolves.toBeUndefined();
  });
  it("queries the legacy name once when it is the current name", async () => {
    const api = fakeRequest({});
    await expect(findGitHubReviewCheck(api.request, { ...input, name: "Paperclip Review" })).resolves.toBeUndefined();
    expect(api.names).toEqual(["Paperclip Review"]);
  });
});
