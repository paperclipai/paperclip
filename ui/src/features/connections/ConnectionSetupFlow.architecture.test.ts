import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("shared connection setup architecture", () => {
  it("keeps both hosts thin and routes provider setup through ConnectionSetupFlow", () => {
    const pageHost = source("../../pages/apps/AppsConnect.tsx");
    const taskHost = source("./ConnectionIntentInteractionBody.tsx");

    for (const host of [pageHost, taskHost]) {
      expect(host).toContain("ConnectionSetupFlow");
      expect(host).not.toContain("CONNECTABLE_APP_DEFINITIONS");
      expect(host).not.toContain("ProviderCredentialField");
      expect(host).not.toContain("getAvailableConnectionMethods");
      expect(host).not.toContain("toolsApi.connectApp");
      expect(host).not.toContain("toolsApi.startOAuth");
    }

    expect(pageHost).not.toContain("connectionIntentsApi");
    expect(taskHost).not.toContain("connect-helpers");
    expect(taskHost).not.toContain("connect-ui");
  });
});
