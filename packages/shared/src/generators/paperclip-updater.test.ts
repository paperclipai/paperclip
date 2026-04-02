/**
 * Tests for Paperclip updater
 */

import {
  updatePaperclipRelease,
  updatePaperclipReleaseStatus,
  addPaperclipComment,
} from "./paperclip-updater.js";
import type { ReleaseMetadata } from "./types.js";

describe("updatePaperclipRelease", () => {
  const mockClient = {
    updateIssue: jest.fn(),
    getIssue: jest.fn(),
    addComment: jest.fn(),
  };

  const validMetadata: ReleaseMetadata = {
    released: true,
    releaseVersion: "v2026.090.0",
    releaseUrl: "https://github.com/org/repo/releases/v2026.090.0",
    changelogPath: "CHANGELOG.md#v2026.090.0",
    releasedAt: "2026-03-31T18:00:00Z",
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should throw error for missing issue ID", async () => {
    await expect(
      updatePaperclipRelease("", validMetadata, {})
    ).rejects.toThrow("Issue ID is required");
  });

  test("should throw error if released is false", async () => {
    const invalidMetadata: ReleaseMetadata = {
      ...validMetadata,
      released: false,
    };

    await expect(
      updatePaperclipRelease("issue-123", invalidMetadata, {})
    ).rejects.toThrow("released=true");
  });

  test("should throw error for missing release version", async () => {
    const invalidMetadata: ReleaseMetadata = {
      ...validMetadata,
      releaseVersion: "",
    };

    await expect(
      updatePaperclipRelease("issue-123", invalidMetadata, {})
    ).rejects.toThrow("Release version is required");
  });

  test("should support dry-run mode", async () => {
    const consoleSpy = jest.spyOn(console, "log");

    await updatePaperclipRelease("issue-123", validMetadata, {
      dryRun: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("DRY RUN")
    );
    expect(mockClient.updateIssue).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  test("should call client.updateIssue with correct payload", async () => {
    mockClient.updateIssue.mockResolvedValueOnce(undefined);

    await updatePaperclipRelease("issue-123", validMetadata, {
      paperclipClient: mockClient,
    });

    expect(mockClient.updateIssue).toHaveBeenCalledWith(
      "issue-123",
      expect.objectContaining({
        status: "done",
        metadata: expect.objectContaining({
          released: true,
          releaseVersion: "v2026.090.0",
        }),
      })
    );
  });

  test("should set status to done", async () => {
    mockClient.updateIssue.mockResolvedValueOnce(undefined);

    await updatePaperclipRelease("issue-123", validMetadata, {
      paperclipClient: mockClient,
    });

    const call = mockClient.updateIssue.mock.calls[0];
    expect(call[1].status).toBe("done");
  });

  test("should include releaseUrl in metadata", async () => {
    mockClient.updateIssue.mockResolvedValueOnce(undefined);

    await updatePaperclipRelease("issue-123", validMetadata, {
      paperclipClient: mockClient,
    });

    const call = mockClient.updateIssue.mock.calls[0];
    expect(call[1].metadata.releaseUrl).toBe(validMetadata.releaseUrl);
  });

  test("should include changelogPath in metadata", async () => {
    mockClient.updateIssue.mockResolvedValueOnce(undefined);

    await updatePaperclipRelease("issue-123", validMetadata, {
      paperclipClient: mockClient,
    });

    const call = mockClient.updateIssue.mock.calls[0];
    expect(call[1].metadata.changelogPath).toBe(validMetadata.changelogPath);
  });

  test("should set releasedAt if not provided", async () => {
    mockClient.updateIssue.mockResolvedValueOnce(undefined);

    const metadataWithoutTime: ReleaseMetadata = {
      ...validMetadata,
      releasedAt: undefined,
    };

    await updatePaperclipRelease("issue-123", metadataWithoutTime, {
      paperclipClient: mockClient,
    });

    const call = mockClient.updateIssue.mock.calls[0];
    expect(call[1].metadata.releasedAt).toBeTruthy();
  });

  test("should retry on timeout error", async () => {
    mockClient.updateIssue
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);

    await updatePaperclipRelease("issue-123", validMetadata, {
      paperclipClient: mockClient,
      maxRetries: 2,
      initialDelayMs: 1,
    });

    expect(mockClient.updateIssue).toHaveBeenCalledTimes(2);
  });

  test("should throw error after max retries", async () => {
    mockClient.updateIssue.mockRejectedValue(
      new Error("ECONNREFUSED")
    );

    await expect(
      updatePaperclipRelease("issue-123", validMetadata, {
        paperclipClient: mockClient,
        maxRetries: 2,
        initialDelayMs: 1,
      })
    ).rejects.toThrow("Failed to update Paperclip issue");
  });

  test("should not retry non-retryable errors", async () => {
    mockClient.updateIssue.mockRejectedValue(
      new Error("Invalid payload")
    );

    await expect(
      updatePaperclipRelease("issue-123", validMetadata, {
        paperclipClient: mockClient,
        maxRetries: 3,
      })
    ).rejects.toThrow();

    expect(mockClient.updateIssue).toHaveBeenCalledTimes(1);
  });

  test("should warn if no client provided", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn");

    await updatePaperclipRelease("issue-123", validMetadata, {
      dryRun: false,
    });

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No Paperclip client")
    );

    consoleWarnSpy.mockRestore();
  });
});

describe("updatePaperclipReleaseStatus", () => {
  const mockClient = {
    updateIssue: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should update status to done", async () => {
    mockClient.updateIssue.mockResolvedValueOnce(undefined);

    await updatePaperclipReleaseStatus("issue-123", "done", {
      paperclipClient: mockClient,
    });

    expect(mockClient.updateIssue).toHaveBeenCalledWith("issue-123", {
      status: "done",
    });
  });

  test("should support dry-run mode", async () => {
    const consoleSpy = jest.spyOn(console, "log");

    await updatePaperclipReleaseStatus("issue-123", "done", {
      dryRun: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("DRY RUN")
    );
    expect(mockClient.updateIssue).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe("addPaperclipComment", () => {
  const mockClient = {
    addComment: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should add comment to issue", async () => {
    mockClient.addComment.mockResolvedValueOnce(undefined);

    await addPaperclipComment("issue-123", "Test comment", {
      paperclipClient: mockClient,
    });

    expect(mockClient.addComment).toHaveBeenCalledWith(
      "issue-123",
      expect.objectContaining({
        body: "Test comment",
      })
    );
  });

  test("should set author in comment", async () => {
    mockClient.addComment.mockResolvedValueOnce(undefined);

    await addPaperclipComment("issue-123", "Test comment", {
      paperclipClient: mockClient,
    });

    const call = mockClient.addComment.mock.calls[0];
    expect(call[1].author).toBe("ReleaseGenerator");
  });

  test("should support dry-run mode", async () => {
    const consoleSpy = jest.spyOn(console, "log");

    await addPaperclipComment("issue-123", "Test comment", {
      dryRun: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("DRY RUN")
    );
    expect(mockClient.addComment).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  test("should throw error on failure", async () => {
    mockClient.addComment.mockRejectedValueOnce(
      new Error("API error")
    );

    await expect(
      addPaperclipComment("issue-123", "Test comment", {
        paperclipClient: mockClient,
      })
    ).rejects.toThrow("API error");
  });

  test("should warn if no client provided", async () => {
    const consoleWarnSpy = jest.spyOn(console, "warn");

    await addPaperclipComment("issue-123", "Test comment", {});

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No Paperclip client")
    );

    consoleWarnSpy.mockRestore();
  });
});
