/**
 * Tests for GitHub poster
 */

import { postPRComment, RateLimitError } from "./github-poster.js";

// Mock fetch for testing
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("postPRComment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validPrUrl = "https://github.com/owner/repo/pull/123";
  const validToken = "gh_test_token_123";
  const validComment = "Test comment";

  test("should throw error for invalid PR URL", async () => {
    await expect(
      postPRComment("not-a-url", validComment, validToken)
    ).rejects.toThrow("Invalid GitHub PR URL");
  });

  test("should throw error for empty comment", async () => {
    await expect(
      postPRComment(validPrUrl, "", validToken)
    ).rejects.toThrow("Comment cannot be empty");
  });

  test("should throw error for missing token", async () => {
    await expect(
      postPRComment(validPrUrl, validComment, "")
    ).rejects.toThrow("GitHub token is required");
  });

  test("should throw error for comment exceeding limit", async () => {
    const hugeComment = "x".repeat(70000);

    await expect(
      postPRComment(validPrUrl, hugeComment, validToken)
    ).rejects.toThrow("exceeds GitHub limit");
  });

  test("should support dry-run mode", async () => {
    const consoleSpy = jest.spyOn(console, "log");

    await postPRComment(validPrUrl, validComment, validToken, {
      dryRun: true,
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("DRY RUN")
    );
    expect(mockFetch).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  test("should parse GitHub PR URL and extract info", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await postPRComment(validPrUrl, validComment, validToken);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("repos/owner/repo/issues/123"),
      expect.anything()
    );
  });

  test("should use correct GitHub API endpoint", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await postPRComment(validPrUrl, validComment, validToken);

    const call = mockFetch.mock.calls[0];
    const url = call[0];

    expect(url).toContain("api.github.com");
    expect(url).toContain("/repos/");
    expect(url).toContain("/issues/");
    expect(url).toContain("/comments");
  });

  test("should include auth header with token", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await postPRComment(validPrUrl, validComment, validToken);

    const call = mockFetch.mock.calls[0];
    const options = call[1];

    expect(options.headers.Authorization).toBe(`token ${validToken}`);
  });

  test("should post comment body in request", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await postPRComment(validPrUrl, validComment, validToken);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);

    expect(body.body).toBe(validComment);
  });

  test("should throw error on auth failure (401)", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 401,
      json: async () => ({ message: "Bad credentials" }),
    });

    await expect(
      postPRComment(validPrUrl, validComment, "bad_token")
    ).rejects.toThrow("authentication failed");
  });

  test("should throw error on not found (404)", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 404,
      json: async () => ({ message: "Not Found" }),
    });

    await expect(
      postPRComment(validPrUrl, validComment, validToken)
    ).rejects.toThrow("not found");
  });

  test("should retry on rate limit with backoff", async () => {
    mockFetch
      .mockResolvedValueOnce({
        status: 403,
        json: async () => ({ message: "API rate limit exceeded" }),
      })
      .mockResolvedValueOnce({
        status: 403,
        json: async () => ({ message: "API rate limit exceeded" }),
      })
      .mockResolvedValueOnce({
        status: 201,
        json: async () => ({ id: 1 }),
      });

    const startTime = Date.now();

    await postPRComment(validPrUrl, validComment, validToken, {
      maxRetries: 3,
      initialDelayMs: 10,
    });

    const elapsed = Date.now() - startTime;

    // Should have retried with backoff (10ms + 20ms + attempt time)
    expect(elapsed).toBeGreaterThan(20);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("should fail after max retries exceeded", async () => {
    mockFetch.mockResolvedValue({
      status: 403,
      json: async () => ({ message: "API rate limit exceeded" }),
    });

    await expect(
      postPRComment(validPrUrl, validComment, validToken, {
        maxRetries: 2,
        initialDelayMs: 1,
      })
    ).rejects.toThrow("Failed to post GitHub comment");
  });

  test("should handle API-provided error messages", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 400,
      json: async () => ({ message: "Invalid request body" }),
    });

    await expect(
      postPRComment(validPrUrl, validComment, validToken)
    ).rejects.toThrow("Invalid request body");
  });

  test("should parse alternative GitHub URL format", async () => {
    const apiUrl = "https://api.github.com/repos/owner/repo/pulls/456";

    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await postPRComment(apiUrl, validComment, validToken);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("456"),
      expect.anything()
    );
  });

  test("should set correct content type header", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 1 }),
    });

    await postPRComment(validPrUrl, validComment, validToken);

    const call = mockFetch.mock.calls[0];
    const options = call[1];

    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  test("should succeed on 201 response", async () => {
    mockFetch.mockResolvedValueOnce({
      status: 201,
      json: async () => ({ id: 123, body: validComment }),
    });

    // Should not throw
    await expect(
      postPRComment(validPrUrl, validComment, validToken)
    ).resolves.not.toThrow();
  });
});
