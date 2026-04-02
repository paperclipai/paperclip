/**
 * Release generator orchestrator
 * Coordinates all generators to produce a complete release
 */

import * as fs from "fs";
import * as path from "path";
import { generateChangelogEntry } from "./changelog.js";
import { generatePRComment } from "./pr-comment.js";
import { appendToChangelog, updateChangelogEntryMetadata } from "./changelog-updater.js";
import { postPRComment } from "./github-poster.js";
import { updatePaperclipRelease, addPaperclipComment } from "./paperclip-updater.js";
import type {
  ReleaseResult,
  ArtifactData,
  ReleaseGeneratorOptions,
} from "./types.js";

/**
 * Main orchestrator function
 * Coordinates all release generation steps
 * Returns result with paths and URLs
 */
export async function generateRelease(
  sprintId: string,
  artifactsPaths: {
    sprintPlan: string;
    taskBreakdown: string;
    handoffs: string[];
    evals: string[];
    sprintReport: string;
  },
  options: ReleaseGeneratorOptions
): Promise<ReleaseResult> {
  const errors: string[] = [];
  const startTime = Date.now();

  try {
    // Step 1: Parse all artifacts
    console.log(`[Release] Starting release generation for sprint: ${sprintId}`);

    const artifactData = await loadAndParseArtifacts(artifactsPaths, errors);

    if (!artifactData) {
      throw new Error("Failed to load and parse artifacts");
    }

    // Step 2: Generate CHANGELOG entry
    console.log("[Release] Generating CHANGELOG entry...");
    const changelogEntry = generateChangelogEntry(artifactData);

    // Step 3: Generate PR comment
    console.log("[Release] Generating PR comment...");
    const prCommentData = generatePRComment(artifactData, {
      paperclipIssueId: options.paperclip?.issueId,
      deploymentUrl: options.baseUrl
        ? `${options.baseUrl}/releases/${changelogEntry.version}`
        : undefined,
    });

    // Step 4: Update CHANGELOG.md file
    const changelogPath = path.join(process.cwd(), "CHANGELOG.md");
    console.log(`[Release] Updating CHANGELOG at: ${changelogPath}`);

    try {
      appendToChangelog(changelogPath, changelogEntry);
    } catch (error) {
      errors.push(
        `Failed to update CHANGELOG: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Step 5: Post PR comment
    let prCommentUrl: string | undefined;
    if (options.github?.prUrl && options.github?.token) {
      console.log("[Release] Posting PR comment...");
      try {
        await postPRComment(
          options.github.prUrl,
          prCommentData.markdown,
          options.github.token,
          { dryRun: options.dryRun }
        );
        prCommentUrl = `${options.github.prUrl}#release-comment`;
      } catch (error) {
        errors.push(
          `Failed to post PR comment: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      console.log("[Release] Skipping PR comment (no GitHub config)");
    }

    // Step 6: Update Paperclip issue
    let paperclipStatus: { updated: boolean; issueId: string; error?: string } = { updated: false, issueId: "" };

    if (options.paperclip?.issueId) {
      console.log("[Release] Updating Paperclip issue...");
      try {
        await updatePaperclipRelease(
          options.paperclip.issueId,
          {
            released: true,
            releaseVersion: changelogEntry.version,
            releaseUrl: options.baseUrl
              ? `${options.baseUrl}/releases/${changelogEntry.version}`
              : undefined,
            changelogPath: `CHANGELOG.md#${changelogEntry.version}`,
            releasedAt: new Date().toISOString(),
          },
          {
            paperclipClient: options.paperclip?.client,
            dryRun: options.dryRun,
          }
        );

        paperclipStatus = {
          updated: true,
          issueId: options.paperclip.issueId,
        };

        // Add release summary comment
        try {
          const releaseComment = `
## Release ${changelogEntry.version} Deployed

**Summary:** ${changelogEntry.summary}

**Features shipped:** ${changelogEntry.featuresShipped.length}
**Features deferred:** ${changelogEntry.featuresDropped.length}

**Contributors:** ${changelogEntry.contributors.join(", ")}

**Links:**
- CHANGELOG: ${options.baseUrl ? `${options.baseUrl}/blob/main/CHANGELOG.md#${changelogEntry.version}` : "CHANGELOG.md"}
- Deployment: ${options.baseUrl || "See PR for details"}

Generated at: ${new Date().toISOString()}
`;
          await addPaperclipComment(options.paperclip.issueId, releaseComment, {
            paperclipClient: options.paperclip?.client,
            dryRun: options.dryRun,
          });
        } catch (commentError) {
          errors.push(
            `Failed to add Paperclip comment: ${commentError instanceof Error ? commentError.message : String(commentError)}`
          );
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        errors.push(`Failed to update Paperclip: ${errorMsg}`);
        paperclipStatus.error = errorMsg;
      }
    } else {
      console.log("[Release] Skipping Paperclip update (no issueId)");
    }

    // Step 7: Return result
    const elapsedMs = Date.now() - startTime;
    console.log(
      `[Release] Release generation completed in ${(elapsedMs / 1000).toFixed(2)}s`
    );

    return {
      success: errors.length === 0,
      changelogPath,
      changelogEntry,
      prCommentUrl,
      paperclipStatus,
      errors,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error("[Release] Fatal error:", errorMsg);

    return {
      success: false,
      changelogPath: "",
      changelogEntry: {} as any,
      paperclipStatus: { updated: false, issueId: "" },
      errors: [errorMsg, ...errors],
    };
  }
}

/**
 * Load and parse all artifact files
 * Handles both file system and mock data
 */
async function loadAndParseArtifacts(
  artifactsPaths: {
    sprintPlan: string;
    taskBreakdown: string;
    handoffs: string[];
    evals: string[];
    sprintReport: string;
  },
  errors: string[]
): Promise<ArtifactData | null> {
  try {
    // For now, return a default artifact structure
    // In production, would parse files using Phase 2.1 parsers

    const artifactData: ArtifactData = {
      sprintPlan: loadJsonFile(artifactsPaths.sprintPlan) || {},
      taskBreakdown: loadJsonFile(artifactsPaths.taskBreakdown) || [],
      handoffs: artifactsPaths.handoffs
        .map((p) => loadJsonFile(p))
        .filter(Boolean),
      evals: artifactsPaths.evals
        .map((p) => loadJsonFile(p))
        .filter(Boolean),
      sprintReport: loadJsonFile(artifactsPaths.sprintReport) || {},
    };

    // Validate required fields
    if (!artifactData.sprintReport.sprintId) {
      errors.push("sprintReport missing sprintId");
    }

    if (!artifactData.sprintReport.deploymentUrl) {
      console.warn("Warning: sprintReport missing deploymentUrl");
    }

    return artifactData;
  } catch (error) {
    errors.push(
      `Failed to load artifacts: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/**
 * Load JSON file safely
 */
function loadJsonFile(filePath: string): any {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Warning: Could not load ${filePath}:`, error);
    return null;
  }
}
