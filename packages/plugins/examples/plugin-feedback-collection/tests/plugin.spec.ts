import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin-feedback-collection", () => {
  it("ingests Jira feedback through tool call and creates an issue", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool(
      "ingest_feedback",
      {
        source: "jira",
        payload: {
          key: "ENG-42",
          fields: {
            summary: "Build fails on Windows",
            description: "npm install fails with ENOENT",
            priority: { name: "High" },
          },
        },
        labels: ["feedback", "jira"],
      },
      { companyId: "cmp-1" },
    );

    expect(result.content).toContain("Created issue");

    const issues = await harness.ctx.issues.list({ companyId: "cmp-1", limit: 20, offset: 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toContain("Build fails on Windows");
    expect(issues[0]?.priority).toBe("high");
  });

  it("requires webhook token when webhookAuthSecretRef is configured", async () => {
    const harness = createTestHarness({
      manifest,
      config: { defaultCompanyId: "cmp-2", webhookAuthSecretRef: "secrets://feedback-token" },
    });
    await plugin.definition.setup(harness.ctx);

    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "slack",
        headers: {},
        rawBody: JSON.stringify({ text: "No token request" }),
        requestId: "req-1",
      }),
    ).rejects.toThrow("Unauthorized webhook");

    await plugin.definition.onWebhook?.({
      endpointKey: "slack",
      headers: { "x-feedback-token": "resolved:secrets://feedback-token" },
      rawBody: JSON.stringify({ text: "Token ok", companyId: "cmp-2" }),
      requestId: "req-2",
    });

    const issues = await harness.ctx.issues.list({ companyId: "cmp-2", limit: 20, offset: 0 });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toContain("Slack feedback");
  });
});
