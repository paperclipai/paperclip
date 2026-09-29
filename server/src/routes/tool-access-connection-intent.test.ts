import { describe, expect, it } from "vitest";
import {
  cloudConnectorEnrollmentReturnPath,
  cloudConnectorEnrollmentOutcomeHtml,
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

describe("inline enrollment completion", () => {
  it("closes enrollment without redirecting the task and retains a safe setup fallback", () => {
    const html = cloudConnectorEnrollmentOutcomeHtml("GMA", "/apps/connect?source=gmail&intent=request-1&enrollment_host=dialog");
    expect(html).toContain("window.close()");
    expect(html).not.toContain("window.location");
    expect(html).toContain("/GMA/apps/connect?source=gmail&intent=request-1");
    expect(html).toContain("cloud_connector=enrolled");
  });

  it("does not embed an external fallback or script-significant return path", () => {
    expect(cloudConnectorEnrollmentOutcomeHtml("GMA", "https://evil.example/")).not.toContain("evil.example");
    expect(cloudConnectorEnrollmentOutcomeHtml("GMA", "/apps/connect?source=</script>")).not.toContain("source=</script>");
  });

  it("returns a task enrollment fallback to its verified task", () => {
    const html = cloudConnectorEnrollmentOutcomeHtml("GMA", "/apps/connect?source=gmail", "task-1");
    expect(html).toContain("Return to task");
    expect(html).toContain("/GMA/issues/task-1");
    expect(html).not.toContain("/apps/connect");
  });
});
