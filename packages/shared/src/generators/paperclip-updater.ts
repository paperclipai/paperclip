/**
 * Paperclip issue updater
 * Updates sprint root issue with release metadata
 */

import type { ReleaseMetadata } from "./types.js";

/**
 * Update Paperclip sprint issue with release metadata
 * Sets status to 'done' and adds release information
 */
export async function updatePaperclipRelease(
  issueId: string,
  metadata: ReleaseMetadata,
  options?: {
    paperclipClient?: any;
    dryRun?: boolean;
    maxRetries?: number;
    initialDelayMs?: number;
  }
): Promise<void> {
  const dryRun = options?.dryRun ?? false;
  const maxRetries = options?.maxRetries ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 1000;

  // Validate inputs
  if (!issueId) {
    throw new Error("Issue ID is required");
  }

  if (!metadata.released) {
    throw new Error("Release metadata must have released=true");
  }

  if (!metadata.releaseVersion) {
    throw new Error("Release version is required");
  }

  // In dry-run mode, just log and return
  if (dryRun) {
    logDryRun(issueId, metadata);
    return;
  }

  // If no client provided, use a mock/no-op
  if (!options?.paperclipClient) {
    console.warn(
      "Warning: No Paperclip client provided. Release metadata not updated."
    );
    return;
  }

  const client = options.paperclipClient;

  // Prepare update payload
  const updatePayload = {
    status: "done",
    metadata: {
      released: metadata.released,
      releaseVersion: metadata.releaseVersion,
      releasedAt: metadata.releasedAt || new Date().toISOString(),
      ...(metadata.releaseUrl && { releaseUrl: metadata.releaseUrl }),
      ...(metadata.changelogPath && { changelogPath: metadata.changelogPath }),
    },
  };

  // Attempt update with retry logic
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Update issue
      await client.updateIssue(issueId, updatePayload);
      return; // Success
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Determine if error is retryable
      const isRetryable =
        error instanceof Error &&
        (error.message.includes("timeout") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("429") || // Rate limit
          error.message.includes("503")); // Service unavailable

      if (isRetryable && attempt < maxRetries) {
        // Exponential backoff
        const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
        await sleep(delayMs);
        continue;
      }

      // Non-retryable or max retries exceeded
      throw new Error(
        `Failed to update Paperclip issue after ${attempt} attempt(s): ${lastError.message}`
      );
    }
  }

  throw lastError || new Error("Failed to update Paperclip issue");
}

/**
 * Update only the release status without full metadata
 * Useful for partial updates
 */
export async function updatePaperclipReleaseStatus(
  issueId: string,
  status: "done" | "in_progress" | "pending",
  options?: { paperclipClient?: any; dryRun?: boolean }
): Promise<void> {
  const dryRun = options?.dryRun ?? false;

  if (dryRun) {
    console.log(
      `DRY RUN: Would update Paperclip issue ${issueId} status to '${status}'`
    );
    return;
  }

  if (!options?.paperclipClient) {
    console.warn("Warning: No Paperclip client provided. Status not updated.");
    return;
  }

  const client = options.paperclipClient;
  await client.updateIssue(issueId, { status });
}

/**
 * Retrieve current release metadata from Paperclip issue
 */
export async function getPaperclipReleaseMetadata(
  issueId: string,
  options?: { paperclipClient?: any }
): Promise<ReleaseMetadata | null> {
  if (!options?.paperclipClient) {
    return null;
  }

  const client = options.paperclipClient;

  try {
    const issue = await client.getIssue(issueId);

    if (!issue.metadata) {
      return null;
    }

    return {
      released: issue.metadata.released || false,
      releaseVersion: issue.metadata.releaseVersion,
      releaseUrl: issue.metadata.releaseUrl,
      changelogPath: issue.metadata.changelogPath,
      releasedAt: issue.metadata.releasedAt,
    };
  } catch (error) {
    console.error(`Failed to retrieve Paperclip issue ${issueId}:`, error);
    return null;
  }
}

/**
 * Add a comment to the Paperclip issue
 */
export async function addPaperclipComment(
  issueId: string,
  comment: string,
  options?: {
    paperclipClient?: any;
    dryRun?: boolean;
  }
): Promise<void> {
  const dryRun = options?.dryRun ?? false;

  if (dryRun) {
    console.log(
      `DRY RUN: Would add comment to Paperclip issue ${issueId}:`
    );
    console.log(comment);
    return;
  }

  if (!options?.paperclipClient) {
    console.warn("Warning: No Paperclip client provided. Comment not added.");
    return;
  }

  const client = options.paperclipClient;

  try {
    await client.addComment(issueId, {
      body: comment,
      author: "ReleaseGenerator",
    });
  } catch (error) {
    console.error(
      `Failed to add comment to Paperclip issue ${issueId}:`,
      error
    );
    throw error;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Log dry-run output
 */
function logDryRun(issueId: string, metadata: ReleaseMetadata): void {
  console.log("\n=== DRY RUN: Paperclip Release Update ===");
  console.log(`Issue ID: ${issueId}`);
  console.log(`Status: done`);
  console.log(`Metadata:`, JSON.stringify(metadata, null, 2));
  console.log("==========================================\n");
}
