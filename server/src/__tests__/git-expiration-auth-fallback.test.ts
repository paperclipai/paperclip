import { describe, expect, it } from "vitest";
import { gitExpirationSkipReason, withAnonymousGitFallback } from "../services/git-workspace-expiration.js";
import { GitCacheRestorationFailure } from "../services/git-workspace-restoration.js";

describe("Git expiration upstream access", () => {
  it("falls back to anonymous access when the company identity cannot be resolved", async () => {
    const unavailable = withAnonymousGitFallback(async () => {
      throw new Error("No managed GitHub identity is available for this run");
    });
    await expect(unavailable("https://github.com/example/public")).resolves.toBeNull();
  });

  it("passes resolved credentials through unchanged", async () => {
    const credential = { env: { GIT_ASKPASS: "/bin/true" }, configArgs: ["-c", "credential.helper="] };
    const resolved = withAnonymousGitFallback(async () => credential);
    await expect(resolved("https://github.com/example/private")).resolves.toBe(credential);
  });

  it("names upstream verification failures instead of reporting them as inspection failures", () => {
    expect(gitExpirationSkipReason(new GitCacheRestorationFailure())).toBe("upstream_commit_unverified");
    expect(gitExpirationSkipReason(new Error("unpushed_managed_checkout"))).toBe("unpushed_managed_checkout");
    expect(gitExpirationSkipReason(new Error("spawn git ENOENT"))).toBe("inspection_failed");
  });
});
