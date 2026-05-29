import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resolveMostRecentIssueAttachmentForUpload } from "../services/awaiting-human-issue-attachments.js";

const listAttachments = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ listAttachments }),
}));

describe("awaiting human issue attachments", () => {
  it("returns null when the issue has no attachments", async () => {
    listAttachments.mockResolvedValueOnce([]);
    const resolved = await resolveMostRecentIssueAttachmentForUpload({} as Db, {
      companyId: "company-1",
      issueId: "issue-1",
    });
    expect(resolved).toBeNull();
  });

  it("returns the most recent company-scoped issue attachment", async () => {
    listAttachments.mockResolvedValueOnce([
      {
        id: "attachment-new",
        companyId: "company-1",
        issueId: "issue-1",
        originalFilename: "joincitro_logo (1).jpeg",
        objectKey: "company-1/logo.jpeg",
        contentType: "image/jpeg",
        byteSize: 16,
        sha256: "sha-logo",
      },
      {
        id: "attachment-old",
        companyId: "company-1",
        issueId: "issue-1",
        originalFilename: "older.png",
        objectKey: "company-1/older.png",
        contentType: "image/png",
        byteSize: 8,
        sha256: "sha-old",
      },
      {
        id: "attachment-other-company",
        companyId: "company-2",
        issueId: "issue-1",
        originalFilename: "ignore-me.png",
        objectKey: "company-2/ignore.png",
        contentType: "image/png",
        byteSize: 8,
        sha256: "sha-ignore",
      },
    ]);

    const resolved = await resolveMostRecentIssueAttachmentForUpload({} as Db, {
      companyId: "company-1",
      issueId: "issue-1",
    });

    expect(resolved).toEqual({
      attachmentId: "attachment-new",
      href: "/api/attachments/attachment-new/content",
      label: "joincitro_logo (1).jpeg",
      objectKey: "company-1/logo.jpeg",
      contentType: "image/jpeg",
      byteSize: 16,
      sha256: "sha-logo",
    });
  });
});
