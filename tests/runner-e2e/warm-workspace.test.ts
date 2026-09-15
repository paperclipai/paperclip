import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daytonaWarmContinuityTask } from "./catalog.js";
import {
  nativeWarmProcessFailures,
  readWarmWorkspaceFile,
} from "./warm-workspace.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "warm-workspace-test-"),
  );
  temporaryDirectories.push(workspacePath);
  const binding = {
    version: 1,
    runId: "run",
    companyId: "company",
    agentId: "agent",
    taskId: "task",
    folders: { task: "folder" },
  };
  const saved = {
    runId: "run",
    state: "saved",
    active: false,
    lastSavedAt: "2026-09-09T04:00:00Z",
    finalCheckpointAt: "2026-09-09T04:00:00Z" as string | null | undefined,
  };
  const response = {
    ok: () => true,
    status: () => 200,
    text: async () => "T1-nonce\n",
  };
  const fullRun = {
    id: "run",
    companyId: "company",
    agentId: "agent",
    status: "succeeded",
    startedAt: "2026-09-09T03:59:00Z" as string | null,
    finishedAt: "2026-09-09T04:00:01Z" as string | null,
    contextSnapshot: { paperclipWorkFolders: binding } as Record<
      string,
      unknown
    > | null,
  };
  const api = {
    get: vi
      .fn()
      .mockImplementation(async (url: string) =>
        url === "/api/heartbeat-runs/run" ? fullRun : [saved],
      ),
    request: { get: vi.fn().mockResolvedValue(response) },
  };
  return {
    input: {
      api,
      run: { id: "run", companyId: "company", agentId: "agent" },
      issueId: "task",
      workspacePath,
      filename: "daytona-warm-nonce.txt",
    },
    fullRun,
    binding,
    saved,
  };
}

describe("warm workspace persistence observation", () => {
  it.each([true, false])(
    "keeps writes in the correct folder across separate shells (scoped=%s)",
    async (scoped) => {
      const { input } = await fixture();
      const taskDirectory = path.join(input.workspacePath, "task files");
      await mkdir(taskDirectory);
      const env = { ...process.env };
      if (scoped) env.PAPERCLIP_TASK_DIR = taskDirectory;
      else delete env.PAPERCLIP_TASK_DIR;
      const prompts = [
        daytonaWarmContinuityTask.buildPrompt("nonce"),
        ...daytonaWarmContinuityTask.buildFollowupMessages!("nonce"),
      ];
      for (const prompt of prompts) {
        const script = prompt.match(/```sh\n([\s\S]*?)\n```/)?.[1];
        expect(script).toBeTruthy();
        await promisify(execFile)("sh", ["-c", script!], {
          cwd: input.workspacePath,
          env,
        });
      }
      expect(
        await readFile(
          path.join(
            scoped ? taskDirectory : input.workspacePath,
            input.filename,
          ),
          "utf8",
        ),
      ).toBe("T1-nonce\nT2-nonce\nT3-nonce\n");
      if (scoped)
        await expect(
          readFile(path.join(input.workspacePath, input.filename)),
        ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([undefined, "wrong\n", "T1-nonce", "T1-nonce\n\n"])(
    "rejects missing or changed prior content without repairing it: %j",
    async (prior) => {
      const { input } = await fixture();
      const filename = path.join(input.workspacePath, input.filename);
      if (prior !== undefined) await writeFile(filename, prior);
      const prompt =
        daytonaWarmContinuityTask.buildFollowupMessages!("nonce")[0]!;
      const script = prompt.match(/```sh\n([\s\S]*?)\n```/)![1]!;
      await expect(
        promisify(execFile)("sh", ["-c", script], {
          cwd: input.workspacePath,
          env: { ...process.env, PAPERCLIP_TASK_DIR: input.workspacePath },
        }),
      ).rejects.toThrow();
      if (prior === undefined) {
        await expect(readFile(filename)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } else {
        expect(await readFile(filename, "utf8")).toBe(prior);
      }
    },
  );

  it("rejects repeating the initial write without truncating saved work", async () => {
    const { input } = await fixture();
    const filename = path.join(input.workspacePath, input.filename);
    await writeFile(filename, "T1-nonce\n");
    const script = daytonaWarmContinuityTask
      .buildPrompt("nonce")
      .match(/```sh\n([\s\S]*?)\n```/)![1]!;
    await expect(
      promisify(execFile)("sh", ["-c", script], {
        cwd: input.workspacePath,
        env: { ...process.env, PAPERCLIP_TASK_DIR: input.workspacePath },
      }),
    ).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe("T1-nonce\n");
  });

  it("hydrates an abbreviated run before reading scoped bytes without a host mirror", async () => {
    const { input } = await fixture();
    expect(await readWarmWorkspaceFile(input)).toEqual({
      source: "task-cache",
      content: "T1-nonce\n",
    });
    expect(input.api.get).toHaveBeenCalledWith(
      "/api/companies/company/work-folders/task/task/sync",
    );
    expect(input.api.request.get).toHaveBeenCalledWith(
      "/api/companies/company/work-folders/task/task/content?path=daytona-warm-nonce.txt",
    );
  });

  it("does not substitute a stale host copy for a missing cached file", async () => {
    const { input } = await fixture();
    await writeFile(
      path.join(input.workspacePath, input.filename),
      "T1-nonce\n",
    );
    input.api.request.get.mockResolvedValue({
      ok: () => false,
      status: () => 404,
    });
    await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
      "download returned 404",
    );
  });

  it("does not infer an unscoped run from another abbreviated API response", async () => {
    const { input } = await fixture();
    input.api.get.mockResolvedValue(input.run);
    await writeFile(
      path.join(input.workspacePath, input.filename),
      "stale host copy",
    );
    await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
      "Full run context is required",
    );
    expect(input.api.request.get).not.toHaveBeenCalled();
  });

  it("rejects a full response for a different run", async () => {
    const { input, fullRun } = await fixture();
    fullRun.id = "different-run";
    await expect(readWarmWorkspaceFile(input)).rejects.toThrow();
    expect(input.api.get).toHaveBeenCalledTimes(1);
    expect(input.api.request.get).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "timed_out", "running"])(
    "rejects a %s run even when its periodic checkpoint is saved",
    async (status) => {
      const { input, fullRun } = await fixture();
      fullRun.status = status;
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
        "Warm turn must succeed",
      );
      expect(input.api.request.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    { finalCheckpointAt: undefined },
    { finalCheckpointAt: null },
    { finalCheckpointAt: "invalid" },
    { finalCheckpointAt: "2026-09-09T03:58:59Z" },
    { finalCheckpointAt: "2026-09-09T04:00:02Z" },
    { lastSavedAt: "2026-09-09T03:59:59Z" },
    { lastSavedAt: "2026-09-09T04:00:02Z" },
  ])(
    "rejects periodic-only or unrelated finalization evidence: %j",
    async (override) => {
      const { input, saved } = await fixture();
      Object.assign(saved, override);
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
        "explicit finalization",
      );
      expect(input.api.request.get).not.toHaveBeenCalled();
    },
  );

  it.each(["startedAt", "finishedAt"] as const)(
    "rejects missing run boundary %s",
    async (field) => {
      const { input, fullRun } = await fixture();
      fullRun[field] = null;
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
        "explicit finalization",
      );
      expect(input.api.request.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    { runId: "older-run" },
    { state: "failed" },
    { state: "saving" },
    { active: true },
    { lastSavedAt: null },
  ])(
    "rejects incomplete or unrelated checkpoint evidence: %j",
    async (override) => {
      const { input, saved } = await fixture();
      Object.assign(saved, override);
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
        "successful final file save",
      );
      expect(input.api.request.get).not.toHaveBeenCalled();
    },
  );

  it.each(["runId", "companyId", "agentId", "taskId"] as const)(
    "rejects a manifest with a different %s",
    async (field) => {
      const { input, binding } = await fixture();
      binding[field] = "other";
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow();
      expect(input.api.get).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the host workspace contract when the run has no scoped manifest", async () => {
    const { input, fullRun } = await fixture();
    fullRun.contextSnapshot = null;
    await writeFile(
      path.join(input.workspacePath, input.filename),
      "T1-local\n",
    );
    expect(await readWarmWorkspaceFile(input)).toEqual({
      source: "host-workspace",
      content: "T1-local\n",
    });
    expect(input.api.get).toHaveBeenCalledTimes(1);
    expect(input.api.request.get).not.toHaveBeenCalled();
  });
});

function processFixture() {
  const runs = [0, 1, 2].map((index) => ({
    id: `run-${index}`,
    companyId: "company",
    agentId: "agent",
    nativeSessionId: "native-session",
    runnerInstanceId: "runner-instance",
    processPid: 100 + index,
    processStartedAt: `2026-09-09T04:0${index}:01Z`,
    startedAt: `2026-09-09T04:0${index}:00Z`,
    finishedAt: `2026-09-09T04:0${index}:10Z`,
  }));
  const groups = runs.map((run, index) => ({
    runId: run.id,
    events:
      index === 0
        ? []
        : [
            {
              eventType: "native.session.process_rotation",
              stream: "system",
              payload: {
                reason: "run_scoped_github_capability",
                previousRunId: runs[index - 1]!.id,
                runId: run.id,
                companyId: run.companyId,
                agentId: run.agentId,
                nativeSessionId: run.nativeSessionId,
                runnerInstanceId: run.runnerInstanceId,
              },
            },
          ],
  }));
  return { runs, groups };
}

describe("native warm process continuity", () => {
  it("requires matching controller events for each run-capability rotation", () => {
    const { runs, groups } = processFixture();
    expect(nativeWarmProcessFailures(runs, groups)).toEqual([]);
  });

  it("retains the same-process requirement without credential rotation", () => {
    const { runs, groups } = processFixture();
    for (const run of runs) {
      run.processPid = runs[0]!.processPid;
      run.processStartedAt = runs[0]!.processStartedAt;
    }
    for (const group of groups) group.events = [];
    expect(nativeWarmProcessFailures(runs, groups)).toEqual([]);
    runs[1]!.processPid += 1;
    expect(nativeWarmProcessFailures(runs, groups)).not.toEqual([]);
  });

  it.each([
    "reason",
    "previousRunId",
    "runId",
    "companyId",
    "agentId",
    "nativeSessionId",
    "runnerInstanceId",
  ] as const)("rejects an unrelated rotation %s", (field) => {
    const { runs, groups } = processFixture();
    groups[1]!.events[0]!.payload[field] = "unrelated";
    expect(nativeWarmProcessFailures(runs, groups)).toHaveLength(1);
  });

  it.each(["missing", "stdout", "duplicate", "configuration_changed"])(
    "rejects %s rotation evidence",
    (kind) => {
      const { runs, groups } = processFixture();
      const events = groups[1]!.events;
      if (kind === "missing") events.pop();
      if (kind === "stdout") events[0]!.stream = "stdout";
      if (kind === "duplicate") events.push(events[0]!);
      if (kind === "configuration_changed") events[0]!.payload.reason = kind;
      expect(nativeWarmProcessFailures(runs, groups)).toHaveLength(1);
    },
  );

  it.each(["invalid", "2026-09-09T04:00:59Z", "2026-09-09T04:01:11Z"])(
    "rejects a process start outside the new run: %s",
    (time) => {
      const { runs, groups } = processFixture();
      runs[1]!.processStartedAt = time;
      expect(nativeWarmProcessFailures(runs, groups).length).toBeGreaterThan(0);
    },
  );

  it("rejects a claimed rotation that kept the previous process", () => {
    const { runs, groups } = processFixture();
    runs[1]!.processPid = runs[0]!.processPid;
    runs[1]!.processStartedAt = runs[0]!.processStartedAt;
    expect(nativeWarmProcessFailures(runs, groups)).toHaveLength(1);
  });

  it("rejects a missing event stream even for stable processes", () => {
    const { runs } = processFixture();
    expect(nativeWarmProcessFailures(runs, [])).toHaveLength(3);
  });
});
