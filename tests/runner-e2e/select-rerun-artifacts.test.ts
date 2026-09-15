import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { selectRerunArtifacts } from "./select-rerun-artifacts.js";
import type { RunnerE2EResult } from "./types.js";

const RUN_ID = "33843305626";
const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_REF = "refs/heads/fix/runner-paid-matrix-integrity-v2";
const WORKFLOW_RUN_URL =
  "https://github.com/paperclipai/paperclip/actions/runs/33843305626";
const RETAINED = "core-compatibility.legacy-codex.local.message-marker";
const RERUN = "core-compatibility.runner-codex.local.plan-revise-accept";
const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function result(executionId: string, status: "passed" | "failed") {
  const [suiteId, profileId, environmentId, caseId] = executionId.split(".");
  return {
    schema: "paperclip.runner-e2e.result/v2",
    executionId,
    suiteId,
    source: {
      sha: SOURCE_SHA,
      ref: SOURCE_REF,
      workflowRunUrl: WORKFLOW_RUN_URL,
    },
    attempt: 1,
    status,
    ...(status === "failed"
      ? { failureClass: "candidate_failure" as const, error: "failed" }
      : {}),
    profileId: profileId!,
    environmentId: environmentId as RunnerE2EResult["environmentId"],
    caseId: caseId!,
    provider: "codex",
    model: "fixture-model",
    runtimeMode: "native",
    startedAt: "2026-09-04T00:00:00.000Z",
    finishedAt: "2026-09-04T00:00:01.000Z",
    durationMs: 1_000,
    cleanup: status === "passed" ? "passed" : "not_started",
  } satisfies RunnerE2EResult;
}

async function addArtifact(input: {
  root: string;
  executionId: string;
  workflowAttempt: number;
  status: "passed" | "failed";
  sourceSha?: string;
  resultExecutionId?: string;
  campaignName?: string;
  flattened?: boolean;
}) {
  const artifactName = `runner-e2e-${RUN_ID}-${input.workflowAttempt}-${input.executionId}`;
  const campaignName =
    input.campaignName ??
    `gha-${RUN_ID}-${input.workflowAttempt}-${input.executionId}`;
  const directory = path.join(
    input.root,
    ...(input.flattened ? [] : [artifactName]),
    campaignName,
    "results",
    "attempt-1",
  );
  await mkdir(directory, { recursive: true });
  const value = result(
    input.resultExecutionId ?? input.executionId,
    input.status,
  );
  await writeFile(
    path.join(directory, "result.json"),
    JSON.stringify({
      ...value,
      source: { ...value.source, sha: input.sourceSha ?? value.source.sha },
    }),
  );
  return { artifactName, campaignName };
}

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "runner-e2e-rerun-artifacts-"),
  );
  cleanupDirectories.push(root);
  return {
    root,
    artifactRoot: path.join(root, "downloaded"),
    selectedRoot: path.join(root, "selected"),
  };
}

function selectionInput(paths: Awaited<ReturnType<typeof fixture>>) {
  return {
    ...paths,
    jobs: {
      jobs: [
        {
          name: RETAINED,
          run_attempt: 1,
          started_at: "2026-09-04T00:00:01.000Z",
        },
        {
          name: RERUN,
          run_attempt: 1,
          started_at: "2026-09-04T00:00:02.000Z",
        },
        // filter=all synthesizes this attempt-2 row even though GitHub retained
        // the successful attempt-1 job. Its original start time exposes it.
        {
          name: RETAINED,
          run_attempt: 2,
          started_at: "2026-09-04T00:00:01.000Z",
        },
        {
          name: RERUN,
          run_attempt: 2,
          started_at: "2026-09-04T01:00:01.000Z",
        },
      ],
      attempts: [
        {
          run_attempt: 1,
          run_started_at: "2026-09-04T00:00:00.000Z",
        },
        {
          run_attempt: 2,
          run_started_at: "2026-09-04T01:00:00.000Z",
        },
      ],
    },
    expectedExecutionIds: [RETAINED, RERUN],
    workflowRunId: RUN_ID,
    workflowRunAttempt: 2,
    sourceSha: SOURCE_SHA,
    sourceRef: SOURCE_REF,
    workflowRunUrl: WORKFLOW_RUN_URL,
  };
}

function singletonSelectionInput(paths: Awaited<ReturnType<typeof fixture>>) {
  const input = selectionInput(paths);
  return {
    ...input,
    jobs: {
      ...input.jobs,
      jobs: input.jobs.jobs.filter((job) => job.name === RERUN),
    },
    expectedExecutionIds: [RERUN],
  };
}

describe("runner E2E workflow rerun artifact selection", () => {
  it("accepts the v8 flattened layout for one expected artifact", async () => {
    const paths = await fixture();
    const latest = await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
      flattened: true,
    });

    const selected = await selectRerunArtifacts(singletonSelectionInput(paths));

    expect(selected).toEqual([
      {
        executionId: RERUN,
        workflowAttempt: 2,
        artifactName: latest.artifactName,
      },
    ]);
    const selectedResult = JSON.parse(
      await readFile(
        path.join(
          paths.selectedRoot,
          latest.artifactName,
          latest.campaignName,
          "results",
          "attempt-1",
          "result.json",
        ),
        "utf8",
      ),
    );
    expect(selectedResult.status).toBe("passed");
  });

  it("does not let an older flattened campaign mask a latest missing artifact", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 1,
      status: "passed",
      flattened: true,
    });

    const selected = await selectRerunArtifacts(singletonSelectionInput(paths));

    expect(selected).toEqual([]);
  });

  it("rejects a flattened campaign when multiple artifacts are expected", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
      flattened: true,
    });

    await expect(selectRerunArtifacts(selectionInput(paths))).rejects.toThrow(
      /downloaded unexpected runner artifact/u,
    );
  });

  it("rejects a flattened campaign beside another root entry", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
      flattened: true,
    });
    await writeFile(path.join(paths.artifactRoot, "unexpected.txt"), "no");

    await expect(
      selectRerunArtifacts(singletonSelectionInput(paths)),
    ).rejects.toThrow(/downloaded unexpected runner artifact/u);
  });

  it("rejects an unrecognized flattened campaign", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
      campaignName: `gha-another-run-2-${RERUN}`,
      flattened: true,
    });

    await expect(
      selectRerunArtifacts(singletonSelectionInput(paths)),
    ).rejects.toThrow(/downloaded unexpected runner artifact/u);
  });

  it("applies source validation to a flattened campaign", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
      sourceSha: "ffffffffffffffffffffffffffffffffffffffff",
      flattened: true,
    });

    await expect(
      selectRerunArtifacts(singletonSelectionInput(paths)),
    ).rejects.toThrow("contains result from another source");
  });

  it("applies execution validation to a flattened campaign", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      resultExecutionId: RETAINED,
      workflowAttempt: 2,
      status: "passed",
      flattened: true,
    });

    await expect(
      selectRerunArtifacts(singletonSelectionInput(paths)),
    ).rejects.toThrow(`contains result for ${RETAINED}`);
  });

  it("combines retained successes with the latest rerun artifact", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RETAINED,
      workflowAttempt: 1,
      status: "passed",
    });
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 1,
      status: "failed",
    });
    const latest = await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
    });

    const selected = await selectRerunArtifacts(selectionInput(paths));

    expect(selected).toEqual([
      {
        executionId: RETAINED,
        workflowAttempt: 1,
        artifactName: `runner-e2e-${RUN_ID}-1-${RETAINED}`,
      },
      {
        executionId: RERUN,
        workflowAttempt: 2,
        artifactName: latest.artifactName,
      },
    ]);
    const selectedResult = JSON.parse(
      await readFile(
        path.join(
          paths.selectedRoot,
          latest.artifactName,
          latest.campaignName,
          "results",
          "attempt-1",
          "result.json",
        ),
        "utf8",
      ),
    );
    expect(selectedResult.status).toBe("passed");
  });

  it("never falls back when the latest workflow attempt has no artifact", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RETAINED,
      workflowAttempt: 1,
      status: "passed",
    });
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 1,
      status: "passed",
    });

    const selected = await selectRerunArtifacts(selectionInput(paths));

    expect(selected.map((entry) => entry.executionId)).toEqual([RETAINED]);
  });

  it("does not let an older pass mask a latest failed artifact", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RETAINED,
      workflowAttempt: 1,
      status: "passed",
    });
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 1,
      status: "passed",
    });
    const latest = await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "failed",
    });

    await selectRerunArtifacts(selectionInput(paths));

    const selectedResult = JSON.parse(
      await readFile(
        path.join(
          paths.selectedRoot,
          latest.artifactName,
          latest.campaignName,
          "results",
          "attempt-1",
          "result.json",
        ),
        "utf8",
      ),
    );
    expect(selectedResult.status).toBe("failed");
  });

  it("rejects artifacts from another source", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RETAINED,
      workflowAttempt: 1,
      status: "passed",
      sourceSha: "ffffffffffffffffffffffffffffffffffffffff",
    });
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
    });

    await expect(selectRerunArtifacts(selectionInput(paths))).rejects.toThrow(
      "contains result from another source",
    );
  });

  it("rejects an artifact carrying another campaign", async () => {
    const paths = await fixture();
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RETAINED,
      workflowAttempt: 1,
      status: "passed",
    });
    await addArtifact({
      root: paths.artifactRoot,
      executionId: RERUN,
      workflowAttempt: 2,
      status: "passed",
      campaignName: `gha-another-run-2-${RERUN}`,
    });

    await expect(selectRerunArtifacts(selectionInput(paths))).rejects.toThrow(
      /must contain only its exact campaign/u,
    );
  });
});
