import { describe, expect, it } from "vitest";
import {
  cloudConnectorEnrollmentReturnPath,
  connectionIntentOAuthOutcomeHtml,
} from "./tool-access.js";

describe("Cloud connector enrollment return path", () => {
  it("returns to the company-prefixed Connections page", () => {
    expect(cloudConnectorEnrollmentReturnPath("APP")).toBe(
      "/APP/apps/connections?cloud_connector=enrolled",
    );
  });

  it("encodes the company prefix as one path segment", () => {
    expect(cloudConnectorEnrollmentReturnPath("QA / Apps")).toBe(
      "/QA%20%2F%20Apps/apps/connections?cloud_connector=enrolled",
    );
  });

  it("returns to the connector setup that started enrollment", () => {
    expect(cloudConnectorEnrollmentReturnPath(
      "APP",
      "/apps/connect?source=google-drive&stage=setup",
    )).toBe(
      "/APP/apps/connect?source=google-drive&stage=setup&cloud_connector=enrolled",
    );
  });

  it("rejects external and unrelated enrollment return paths", () => {
    expect(cloudConnectorEnrollmentReturnPath("APP", "https://evil.example/apps/connect")).toBe(
      "/APP/apps/connections?cloud_connector=enrolled",
    );
    expect(cloudConnectorEnrollmentReturnPath("APP", "/settings")).toBe(
      "/APP/apps/connections?cloud_connector=enrolled",
    );
  });
});

describe("connection intent OAuth callback document", () => {
  it.each(["connected", "declined", "failed"] as const)(
    "posts only the interaction id and %s outcome to the opener",
    (outcome) => {
      const html = connectionIntentOAuthOutcomeHtml({
        interactionId: "interaction-123",
        issueId: "issue-456",
        outcome,
      });

      expect(html).toContain(
        "window.opener.postMessage(message,targetOrigin)",
      );
      expect(html).toContain('"interactionId":"interaction-123"');
      expect(html).toContain(`"outcome":"${outcome}"`);
      expect(html).toContain('"type":"paperclip.connection-intent.oauth"');
      expect(html).not.toMatch(
        /connectionId|authorizationUrl|bearer|token|credential/i,
      );
    },
  );

  it("can return a localhost callback outcome to the numeric-loopback opener", () => {
    const html = connectionIntentOAuthOutcomeHtml({
      interactionId: "interaction-123",
      issueId: "issue-456",
      outcome: "connected",
      openerOrigin: "http://127.0.0.1:3200/apps/connect",
    });

    expect(html).toContain('const targetOrigin="http://127.0.0.1:3200"');
  });

  it("closes the popup when an opener exists and otherwise returns to the same task", () => {
    const html = connectionIntentOAuthOutcomeHtml({
      interactionId: "interaction-123",
      issueId: "issue with/slash",
      outcome: "connected",
    });

    expect(html).toContain("window.close()");
    expect(html).toContain(
      'window.location.replace("/issues/issue%20with%2Fslash")',
    );
  });

  it("escapes script-significant interaction ids", () => {
    const html = connectionIntentOAuthOutcomeHtml({
      interactionId: "</script><script>alert(1)</script>",
      issueId: null,
      outcome: "failed",
    });

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>");
    expect(html).toContain('window.location.replace("/issues")');
  });
});
