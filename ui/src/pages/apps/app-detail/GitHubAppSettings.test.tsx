import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitHubAppSettings } from "./GitHubAppSettings";

const render = (methodConfig: Record<string, unknown>) => renderToStaticMarkup(
  <GitHubAppSettings config={{ methodConfig, token: "outer-secret" }} />,
);

describe("GitHubAppSettings", () => {
  it("shows public configuration and parsed permissions without credential fields", () => {
    const html = render({
      appId: "Iv123abc", installationId: "456", repositories: "acme/repo",
      permissionProfile: "custom", customPermissions: '{"pull_requests":"write","contents":"read"}',
      privateKey: "private-key-secret", clientSecret: "client-secret",
    });
    for (const value of ["Iv123abc", "456", "acme/repo", "pull_requests", "contents", "write", "read", "<table"]) {
      expect(html).toContain(value);
    }
    for (const value of ["outer-secret", "private-key-secret", "client-secret"]) expect(html).not.toContain(value);
    expect(html).not.toContain("<details open");
  });

  it.each(['invalid', '[]', '{}', '{"contents":{"token":"secret"}}'])("handles malformed permissions: %s", (customPermissions) => {
    const html = render({ permissionProfile: "custom", customPermissions });
    expect(html).toContain("Saved custom permissions could not be read");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("secret");
  });

  it("describes preset permissions from the connector definition", () => {
    expect(render({ permissionProfile: "author" })).toContain("Author: write contents and pull requests, read issues");
  });
});
