import { describe, expect, it } from "vitest";
import { resolveRunnerE2ESource } from "./source.js";

describe("runner E2E source provenance", () => {
  it("prefers the resolved target over result and workflow revision contexts", () => {
    expect(
      resolveRunnerE2ESource(
        {
          sha: "result-sha",
          ref: "refs/heads/result",
          workflowRunUrl: "https://example.test/result-run",
        },
        {
          PAPERCLIP_RUNNER_E2E_SOURCE_SHA: "target-sha",
          PAPERCLIP_RUNNER_E2E_SOURCE_REF: "refs/heads/target",
          GITHUB_SHA: "workflow-sha",
          GITHUB_REF: "refs/heads/master",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "paperclipai/paperclip",
          GITHUB_RUN_ID: "123",
        },
      ),
    ).toEqual({
      sha: "target-sha",
      ref: "refs/heads/target",
      workflowRunUrl:
        "https://github.com/paperclipai/paperclip/actions/runs/123",
    });
  });

  it("falls back through retained result provenance, workflow context, and null", () => {
    expect(
      resolveRunnerE2ESource(
        {
          sha: "result-sha",
          ref: null,
          workflowRunUrl: null,
        },
        {
          GITHUB_SHA: "workflow-sha",
          GITHUB_REF: "refs/heads/master",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "paperclipai/paperclip",
          GITHUB_RUN_ID: "456",
        },
      ),
    ).toEqual({
      sha: "result-sha",
      ref: "refs/heads/master",
      workflowRunUrl:
        "https://github.com/paperclipai/paperclip/actions/runs/456",
    });
    expect(resolveRunnerE2ESource(null, {})).toEqual({
      sha: null,
      ref: null,
      workflowRunUrl: null,
    });
  });
});
