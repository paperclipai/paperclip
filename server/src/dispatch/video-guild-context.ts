/**
 * Phase 2 Task 2.4b -- video-guild dispatch context builder.
 *
 * Bridges the dispatcher's call site (heartbeat.ts) and
 * `prepareGuildRunSandbox`'s `videoContext` input. Given an issue title
 * and the process env, decides whether the run is a video-stage run and
 * (if so + creds available) builds the `httpArtifactsClient` so
 * prior-stage artifacts get mirrored into the sandbox at spawn.
 *
 * Behaviour matrix:
 *
 *   issueTitle matches video-<stage>/<requestId>:
 *     - AGENT_FS_URL + AGENT_FS_TOKEN both set ->
 *         returns { requestId, stage, artifacts: httpArtifactsClient(...) }
 *     - either env var missing ->
 *         returns { degraded: true } so the caller can warn-log the
 *         missing-creds path once per dispatch. The sandbox still
 *         spawns, just without the prior-stage mirror.
 *   issueTitle does not match (e.g. eng-typescript-bug, null, undefined):
 *     - returns null. Non-video runs short-circuit silently.
 *
 * Reuses VIDEO_ISSUE_TITLE_PATTERN from guild-worker-env.ts (single
 * source of truth for the video-stage title shape).
 *
 * See docs/superpowers/plans/2026-05-23-video-guild-implementation.md
 * Task 2.4b.
 */
import { httpArtifactsClient } from "./artifacts-client.js";
import { VIDEO_ISSUE_TITLE_PATTERN } from "./guild-worker-env.js";
import type { VideoStage } from "./guild-run-sandbox.js";

import type { ArtifactsClient } from "./artifacts-client.js";

export interface BuildVideoGuildContextInput {
  /** The issue title for the run, or null if no issue is attached. */
  issueTitle: string | null | undefined;
  /** Env-var bag to read AGENT_FS_URL / AGENT_FS_TOKEN from. Pass
   * `process.env` in production; tests inject a Record. */
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export type BuildVideoGuildContextResult =
  | {
      kind: "video";
      requestId: string;
      stage: VideoStage;
      artifacts: ArtifactsClient;
    }
  | {
      kind: "degraded";
      requestId: string;
      stage: VideoStage;
      /** Names of env vars that were missing or empty. */
      missingEnv: string[];
    }
  | null;

/**
 * Returns null for non-video runs (the dispatcher omits videoContext
 * entirely). Returns { kind: 'video', ... } when both env vars are set
 * (dispatcher passes videoContext to prepareGuildRunSandbox). Returns
 * { kind: 'degraded', ... } when the title matches but env vars are
 * missing (dispatcher warn-logs and omits videoContext).
 */
export function buildVideoGuildContext(
  input: BuildVideoGuildContextInput,
): BuildVideoGuildContextResult {
  if (typeof input.issueTitle !== "string") return null;
  const match = input.issueTitle.match(VIDEO_ISSUE_TITLE_PATTERN);
  if (!match) return null;
  const stage = match[1] as VideoStage;
  const requestId = match[2];

  const url = input.env.AGENT_FS_URL?.trim();
  const token = input.env.AGENT_FS_TOKEN?.trim();
  const missingEnv: string[] = [];
  if (!url) missingEnv.push("AGENT_FS_URL");
  if (!token) missingEnv.push("AGENT_FS_TOKEN");
  if (missingEnv.length > 0) {
    return { kind: "degraded", requestId, stage, missingEnv };
  }

  return {
    kind: "video",
    requestId,
    stage,
    artifacts: httpArtifactsClient({ url: url!, token: token! }),
  };
}
