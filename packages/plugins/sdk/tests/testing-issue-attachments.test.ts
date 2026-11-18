import { describe, expect, it } from "vitest";

import type { Issue } from "@paperclipai/shared";
import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";

const manifest = {
  id: "paperclip.test-attachments",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test Attachments",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["issue.attachments.create", "issue.attachments.read"],
  entrypoints: { worker: "./worker.js" },
} satisfies PaperclipPluginManifestV1;

describe("createTestHarness issue attachments", () => {
  it("creates an attachment with the host's content type and filename handling", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ issues: [{ id: "issue-1", companyId: "company-1" } as Issue] });

    const attachment = await harness.ctx.issues.createAttachment("issue-1", "company-1", {
      filename: "logs/crash.log",
      contentType: "TEXT/PLAIN; charset=utf-8",
      contentBase64: Buffer.from("boom").toString("base64"),
    });
    const untyped = await harness.ctx.issues.createAttachment("issue-1", "company-1", {
      filename: "blob",
      contentType: "",
      contentBase64: Buffer.from("x").toString("base64"),
    });

    expect(attachment.contentType).toBe("text/plain");
    expect(attachment.originalFilename).toBe("crash.log");
    expect(attachment.byteSize).toBe(4);
    expect(untyped.contentType).toBe("application/octet-stream");
    expect((await harness.ctx.issues.listAttachments("issue-1", "company-1")).map((row) => row.id)).toEqual([
      attachment.id,
      untyped.id,
    ]);
    await expect(
      harness.ctx.issues.createAttachment("issue-1", "company-1", {
        filename: "big.bin",
        contentType: "application/octet-stream",
        contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
      }),
    ).rejects.toThrow("larger than the 10 MB limit");
  });
});
