/**
 * GitHub PR comment poster
 * Posts comments to GitHub PRs with retry logic and dry-run mode
 */

/**
 * Post a comment to a GitHub PR
 * Supports dry-run mode and automatic retry with exponential backoff
 */
export async function postPRComment(
  prUrl: string,
  comment: string,
  token: string,
  options?: {
    dryRun?: boolean;
    maxRetries?: number;
    initialDelayMs?: number;
  }
): Promise<void> {
  const dryRun = options?.dryRun ?? false;
  const maxRetries = options?.maxRetries ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 1000;

  // Validate inputs
  if (!prUrl || !prUrl.includes("github.com")) {
    throw new Error(`Invalid GitHub PR URL: ${prUrl}`);
  }

  if (!comment || comment.trim().length === 0) {
    throw new Error("Comment cannot be empty");
  }

  if (!token) {
    throw new Error("GitHub token is required");
  }

  if (comment.length > 65536) {
    throw new Error(
      `Comment exceeds GitHub limit (65536 chars): ${comment.length}`
    );
  }

  // In dry-run mode, just log and return
  if (dryRun) {
    logDryRun(prUrl, comment);
    return;
  }

  // Extract owner, repo, and PR number from URL
  const urlParts = extractGitHubPRInfo(prUrl);
  if (!urlParts) {
    throw new Error(`Could not parse GitHub PR URL: ${prUrl}`);
  }

  const { owner, repo, prNumber } = urlParts;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  // Attempt to post with retry logic
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "PaperclipAI/ReleaseGenerator",
        },
        body: JSON.stringify({ body: comment }),
      });

      if (response.status === 201) {
        // Success
        const data = await response.json();
        return;
      } else if (response.status === 401) {
        throw new Error(
          "GitHub authentication failed: invalid or expired token"
        );
      } else if (response.status === 404) {
        throw new Error(
          `GitHub PR not found: ${prUrl}. Check URL and permissions.`
        );
      } else if (response.status === 403) {
        const data = await response.json();
        if (data.message?.includes("API rate limit")) {
          throw new RateLimitError(
            "GitHub API rate limit exceeded. Try again later."
          );
        }
        throw new Error(`GitHub API error: ${data.message || response.statusText}`);
      } else if (response.status >= 500) {
        // Server error - retry
        throw new Error(`GitHub server error (${response.status}). Retrying...`);
      } else {
        const data = await response.json();
        throw new Error(
          `GitHub API error: ${data.message || response.statusText}`
        );
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (
        lastError instanceof RateLimitError ||
        (error instanceof Error && error.message.includes("Retrying..."))
      ) {
        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, etc.
          const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
          await sleep(delayMs);
          continue;
        }
      }

      // Non-retryable error
      if (!(error instanceof RateLimitError)) {
        throw lastError;
      }
    }
  }

  // Max retries exceeded
  throw new Error(
    `Failed to post GitHub comment after ${maxRetries} attempts: ${lastError?.message}`
  );
}

/**
 * Extract GitHub PR information from URL
 */
function extractGitHubPRInfo(
  prUrl: string
): {
  owner: string;
  repo: string;
  prNumber: number;
} | null {
  // Match both formats:
  // https://github.com/owner/repo/pull/123
  // https://api.github.com/repos/owner/repo/pulls/123

  const patterns = [
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
    /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/,
  ];

  for (const pattern of patterns) {
    const match = prUrl.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2],
        prNumber: parseInt(match[3], 10),
      };
    }
  }

  return null;
}

/**
 * Sleep utility for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log dry-run output
 */
function logDryRun(prUrl: string, comment: string): void {
  console.log("\n=== DRY RUN: GitHub PR Comment ===");
  console.log(`PR URL: ${prUrl}`);
  console.log(`Comment length: ${comment.length} chars`);
  console.log("---");
  console.log(comment);
  console.log("===================================\n");
}

/**
 * Rate limit error for retry logic
 */
class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export { RateLimitError };
