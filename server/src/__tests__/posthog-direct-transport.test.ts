import { describe, expect, it, vi } from "vitest";
import { createPostHogDirectTransport, type PostHogNodeClient } from "../services/posthog-direct/transport.js";
import type { CloudPostHogConfig } from "../services/cloud-posthog-config.js";

const config: CloudPostHogConfig = {
  token: "phc_test",
  host: "http://127.0.0.1:1",
  environment: "staging",
  stackId: "stack-123",
  directEnabled: true,
  browserEnabled: false,
  replayEnabled: false,
  replayWorkContentEnabled: false,
  cloudTrialInferenceEnabled: false,
};

const startup = {
  stackSlug: "acme",
  primaryHost: "acme.paperclip.app",
  app: "paperclip",
  schemaVersion: "1",
  version: "1.0.0",
  installId: "install-1",
  installHash: "hash-1",
};

function fakeClient() {
  const captured: string[] = [];
  const groups: string[] = [];
  const client: PostHogNodeClient = {
    capture: (message) => void captured.push(message.event),
    groupIdentify: (message) => void groups.push(message.groupKey),
    flush: async () => {},
    shutdown: async () => {},
  };
  return { client, captured, groups };
}

describe("PostHog direct transport", () => {
  it("re-sends the startup announcement with the first batch after the client failed to load", async () => {
    const fake = fakeClient();
    const factory = vi
      .fn<() => Promise<PostHogNodeClient>>()
      .mockRejectedValueOnce(new Error("import failed"))
      .mockResolvedValue(fake.client);
    const transport = createPostHogDirectTransport(config, { factory });

    await expect(transport.announceWorkspace(startup)).rejects.toThrow("import failed");
    expect(fake.captured).toEqual([]);

    const result = await transport.send({
      app: "paperclip",
      schemaVersion: "1",
      installId: "install-1",
      version: "1.0.0",
      batchId: "batch-1",
      events: [{ event: { name: "routine.created", occurredAt: "2026-11-17T12:00:00.000Z", dimensions: {} }, context: undefined }],
    });

    expect(result).toEqual({ kind: "ok" });
    expect(fake.groups).toEqual(["stack-123"]);
    expect(fake.captured).toEqual(["cloud.workspace_started", "routine.created"]);

    // Sent once only.
    await transport.send({
      app: "paperclip",
      schemaVersion: "1",
      installId: "install-1",
      version: "1.0.0",
      batchId: "batch-2",
      events: [{ event: { name: "routine.created", occurredAt: "2026-11-17T12:00:01.000Z", dimensions: {} }, context: undefined }],
    });
    expect(fake.captured.filter((event) => event === "cloud.workspace_started")).toHaveLength(1);
  });
});
