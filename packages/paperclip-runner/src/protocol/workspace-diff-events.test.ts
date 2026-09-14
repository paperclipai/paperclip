import { describe, expect, it } from "vitest";

import { validatePrpEvent, type PrpEvent } from "./replay-contract.js";

function workspaceEvent(eventType: "workspace.change.updated" | "workspace.diff.recorded"): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `workspace:${eventType}`,
    sourceSeq: eventType === "workspace.change.updated" ? 1 : 2,
    sourceInstanceId: "runner-1",
    sourceKind: "runner",
    runId: "run-1",
    turnId: "turn-1",
    eventType,
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-21T12:00:00.000Z",
    payload: {
      schema: "paperclip.workspace.diff.v1",
      changeSetId: "turn-1:workspace",
      revision: 1,
      source: "runner_verified",
      complete: eventType === "workspace.diff.recorded",
      files: [{
        path: "src/index.ts",
        operation: "modify",
        previousPath: null,
        additions: 1,
        deletions: 1,
        binary: false,
        diff: "--- a/src/index.ts\n+++ b/src/index.ts\n-old\n+new\n",
      }],
      totals: { files: 1, additions: 1, deletions: 1 },
      patchArtifactRef: null,
    },
  };
}

describe("PRP workspace change events", () => {
  it("accepts provisional and complete canonical workspace changes", () => {
    expect(validatePrpEvent(workspaceEvent("workspace.change.updated")).ok).toBe(true);
    expect(validatePrpEvent(workspaceEvent("workspace.diff.recorded")).ok).toBe(true);
  });

  it("rejects traversal paths and incomplete recorded diffs", () => {
    const traversal = workspaceEvent("workspace.diff.recorded");
    traversal.payload.files[0]!.path = "../secret";
    expect(validatePrpEvent(traversal).ok).toBe(false);
    const incomplete = workspaceEvent("workspace.diff.recorded");
    incomplete.payload.complete = false;
    expect(validatePrpEvent(incomplete).ok).toBe(false);
  });

  it("validates a canonical individual workspace-file reference", () => {
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "workspace:file:1",
      sourceSeq: 1,
      sourceInstanceId: "runner-1",
      sourceKind: "runner",
      runId: "run-1",
      turnId: "turn-1",
      eventType: "workspace.file.referenced",
      schemaVersion: 1,
      priority: 1,
      emittedAt: "2026-08-21T12:00:00.000Z",
      payload: {
        schema: "paperclip.workspace.file_reference.v1",
        referenceId: "turn-1:file:guide",
        source: "runner_verified",
        path: "docs/guide.md",
        displayName: "guide.md",
        mediaType: "text/markdown",
        presentation: "document",
        line: null,
        preview: "# Guide\n",
        previewTruncated: false,
        contentDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    };
    expect(validatePrpEvent(event).ok).toBe(true);
    event.payload.path = "/private/guide.md";
    expect(validatePrpEvent(event).ok).toBe(false);
  });
});
