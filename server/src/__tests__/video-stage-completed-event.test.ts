/**
 * Phase 2 Task 2.2 -- video.stage.completed activity_log emission.
 *
 * Pure-function unit tests for `parseVideoStageCompletedEvent`. The
 * helper inspects the closing run's issue title, terminal run status,
 * and agent kind, and returns `{ stage, requestId }` when the
 * dispatcher should emit an activity_log row with
 * action='video.stage.completed'; otherwise null. The caller
 * (heartbeat.ts) wraps the result in a `logActivity` call after the
 * existing skills_ingested emit.
 *
 * Note on vocabulary: heartbeat runs use 'succeeded' for a clean exit,
 * not 'done'; 'done' is the issue-table value. The plan's prose says
 * "issue closes done"; in the run-level wrapper we gate on
 * runStatus='succeeded' which is the closest semantic match (run
 * finished without error).
 *
 * Spec: docs/superpowers/plans/2026-05-23-video-guild-implementation.md
 *   Phase 2 Task 2.2.
 *
 * Design note: the plan's test sketch used an `ingestGuildLearnings`
 * signature that no longer exists. We re-derived from the spirit (one
 * activity_log row per clean video-stage worker exit, details =
 * {stage, request_id}) and modelled the decision as a pure parser so
 * the seam is testable without a DB.
 */
import { describe, expect, it } from "vitest";

import { parseVideoStageCompletedEvent } from "../dispatch/ingest-guild-learnings.js";

const guildAgent = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "video-guild",
  kind: "guild" as const,
} as const;

const nonGuildAgent = {
  id: "00000000-0000-0000-0000-000000000002",
  name: "some-worker",
  kind: "agent" as const,
} as const;

describe("parseVideoStageCompletedEvent", () => {
  it("returns {stage:'research', requestId} when video-research run succeeds", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-research/abc-123",
        runStatus: "succeeded",
      }),
    ).toEqual({ stage: "research", requestId: "abc-123" });
  });

  it("returns {stage:'strategy', requestId} for video-strategy/", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-strategy/xyz-789",
        runStatus: "succeeded",
      }),
    ).toEqual({ stage: "strategy", requestId: "xyz-789" });
  });

  it("returns {stage:'copy', requestId} for video-copy/", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-copy/xyz-789",
        runStatus: "succeeded",
      }),
    ).toEqual({ stage: "copy", requestId: "xyz-789" });
  });

  it("returns {stage:'edit', requestId} for video-edit/", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-edit/xyz-789",
        runStatus: "succeeded",
      }),
    ).toEqual({ stage: "edit", requestId: "xyz-789" });
  });

  it("returns null for a non-video issue title that closes succeeded", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "eng-typescript-bug",
        runStatus: "succeeded",
      }),
    ).toBeNull();
  });

  it("returns null when the run terminal status is 'failed'", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-research/abc-123",
        runStatus: "failed",
      }),
    ).toBeNull();
  });

  it("returns null when the run terminal status is 'cancelled' or 'timed_out'", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-research/abc-123",
        runStatus: "cancelled",
      }),
    ).toBeNull();
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-research/abc-123",
        runStatus: "timed_out",
      }),
    ).toBeNull();
  });

  it("returns null when the request_id segment contains a slash (regex strict)", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-research/foo/bar",
        runStatus: "succeeded",
      }),
    ).toBeNull();
  });

  it("returns null for an unknown stage like video-foo/", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: "video-foo/abc-123",
        runStatus: "succeeded",
      }),
    ).toBeNull();
  });

  it("returns null when issueTitle is null or undefined", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: null,
        runStatus: "succeeded",
      }),
    ).toBeNull();
    expect(
      parseVideoStageCompletedEvent({
        agent: guildAgent,
        issueTitle: undefined,
        runStatus: "succeeded",
      }),
    ).toBeNull();
  });

  it("returns null for a non-guild agent even when title matches and runStatus='succeeded' (defense in depth)", () => {
    expect(
      parseVideoStageCompletedEvent({
        agent: nonGuildAgent,
        issueTitle: "video-research/abc-123",
        runStatus: "succeeded",
      }),
    ).toBeNull();
  });
});
