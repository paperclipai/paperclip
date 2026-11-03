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
  const app = { id: 5566481 };
  const current = { id: 3, name: "QA Review", external_id: "endpoint:7:abc", app };
  const legacy = { id: 1, name: "Paperclip Review", external_id: "endpoint:7:abc", app };
  const renamed = { id: 2, name: "QA Review (old)", external_id: "endpoint:7:abc", app };
  const peer = { id: 4, name: "QA Review", external_id: "endpoint:7:abc", app: { id: 5594216 } };
  const otherHead = { id: 5, name: "QA Review", external_id: "endpoint:7:def", app };
  const input = { headSha: "abc", externalId: "endpoint:7:abc", appId: "5566481", name: "QA Review" };
  function fakeRequest(check_runs: Array<typeof current>) {
    const paths: string[] = [];
    const request = async (path: string) => {
      paths.push(path);
      return { check_runs };
    };
    return { request, paths };
  }

  it("asks GitHub for this App's runs on the head only", async () => {
    const api = fakeRequest([]);
    await findGitHubReviewCheck(api.request, input);
    expect(api.paths).toEqual(["/commits/abc/check-runs?per_page=100&app_id=5566481"]);
  });
  it("prefers the run under the current App name", async () => {
    const api = fakeRequest([legacy, renamed, current]);
    await expect(findGitHubReviewCheck(api.request, input)).resolves.toBe(current);
  });
  it("recovers a run published under the legacy name or an earlier App name", async () => {
    await expect(findGitHubReviewCheck(fakeRequest([peer, legacy]).request, input)).resolves.toBe(legacy);
    await expect(findGitHubReviewCheck(fakeRequest([renamed]).request, input)).resolves.toBe(renamed);
  });
  it("never adopts another App's run or another head's run", async () => {
    await expect(findGitHubReviewCheck(fakeRequest([peer, otherHead]).request, input)).resolves.toBeUndefined();
  });
});
