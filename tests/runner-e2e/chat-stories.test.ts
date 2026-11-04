import { describe, expect, it, vi } from "vitest";
import { assertInterruptedChat, prepareChatBrief, publishChatBrief } from "./chat-stories.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runnerMatrix } from "./catalog.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const run = { id: "run", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "chat" } };
const valid = {
  first: "Read the brief", followup: "Change the launch day", reference: "BRIEF123", marker: "UPDATED123", issueId: "chat",
  boundaryRun: { ...run, status: "running" }, activeAtFollowup: { ...run, status: "running" },
  comments: [{ id: "first", body: "Read the brief" }, { id: "followup", body: "Change the launch day" },
    { id: "answer", authorAgentId: "agent", createdByRunId: "run", body: "BRIEF123 UPDATED123" }],
  runs: [run], revisedPlan: JSON.stringify({ launchDay: "Friday", reference: "BRIEF123", revision: "UPDATED123" }),
};

describe("active chat follow-up oracle", () => {
  it("creates the missing fixture directory and waits for the host-supplied brief", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chat-brief-test-"));
    try {
      const { gate, ready, scriptPath } = await prepareChatBrief(path.join(root, "new workspace"), "fixture");
      const command = promisify(execFile)(process.execPath, [scriptPath], { timeout: 5_000 });
      try {
        await expect.poll(() => readFile(ready, "utf8").catch(() => "")).toBe("waiting");
      } finally {
        await publishChatBrief(gate, "BRIEF fixture result");
        expect((await command).stdout.trim()).toBe("BRIEF fixture result");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("accepts either steering or one queued successor, with the saved correction", () => {
    expect(() => assertInterruptedChat(valid)).not.toThrow();
    expect(() => assertInterruptedChat({ ...valid, runs: [run, { ...run, id: "successor" }], comments: [...valid.comments.slice(0, 2), { ...valid.comments[2]!, createdByRunId: "successor" }] })).not.toThrow();
  });
  it("rejects follow-ups sent after the active boundary", () => {
    expect(() => assertInterruptedChat({ ...valid, boundaryRun: run })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, activeAtFollowup: run })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, activeAtFollowup: { ...valid.activeAtFollowup, id: "other" } })).toThrow();
  });
  it("rejects lost or duplicated input, missing file evidence, and stale plans", () => {
    expect(() => assertInterruptedChat({ ...valid, comments: [...valid.comments, { ...valid.comments[2]!, id: "duplicate-reply" }] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, comments: [...valid.comments.slice(0, 2), { ...valid.comments[2]!, createdByRunId: "unrelated" }] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, comments: valid.comments.filter(c => c.id !== "followup") })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, comments: [...valid.comments, { id: "duplicate", body: valid.followup }] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, comments: [...valid.comments.slice(0, 2), { id: "answer", authorAgentId: "agent", body: "UPDATED123" }] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, revisedPlan: valid.revisedPlan.replace("Friday", "Monday") })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, revisedPlan: "The updated plan is saved." })).toThrow();
  });
  it("rejects failed, unfinished, duplicated, or unrelated execution", () => {
    for (const status of ["running", "queued", "failed", "cancelled"])
      expect(() => assertInterruptedChat({ ...valid, runs: [{ ...run, status }] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, runs: [] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, runs: [run, run, run] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, runs: [run, run] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, runs: [{ ...run, id: "other" }] })).toThrow();
    expect(() => assertInterruptedChat({ ...valid, runs: [{ ...run, contextSnapshot: { issueId: "other" } }] })).toThrow();
  });
  it("keeps setup and interruption stories native, local, opt-in, and outside API-tool overrides", () => {
    const cells = runnerMatrix.filter(cell => cell.suite.id === "agent-chat-stories");
    expect(cells).toHaveLength(6);
    for (const cell of cells) {
      expect(cell.suite.manualOnly).toBe(true);
      expect(cell.profile.generation).toBe("native");
      expect(cell.environment.id).toBe("local");
      expect(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_API_TOOLS_ENABLED).toBeUndefined();
    }
  });
});


describe("bounded chat brief fixture", () => {
  it("publishes the complete brief atomically while a real worker is waiting", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "chat-brief-atomic-"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let releaseWrite!: () => void;
    const pausedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
    let exposedEmptyWrite!: (file: Parameters<typeof writeFile>[0]) => void;
    const emptyWrite = new Promise<Parameters<typeof writeFile>[0]>(resolve => { exposedEmptyWrite = resolve; });
    let running: Promise<{ stdout: string; stderr: string }> | undefined;
    let publishing: Promise<void> | undefined;
    try {
      const brief = await prepareChatBrief(directory, "atomic", 5_000);
      running = promisify(execFile)(process.execPath, [brief.scriptPath]);
      await expect.poll(() => readFile(brief.ready, "utf8").catch(() => "")).toBe("waiting");
      vi.mocked(writeFile).mockImplementationOnce(async (file, data, options) => {
        await actual.writeFile(file, "");
        exposedEmptyWrite(file);
        await pausedWrite;
        await actual.writeFile(file, data, typeof options === "object" ? { ...options, flag: "w" } : options);
      });
      publishing = publishChatBrief(brief.gate, "A complete multiword brief.");
      const stagedFile = await emptyWrite;
      expect(await readFile(stagedFile, "utf8")).toBe("");
      await expect(readFile(brief.gate, "utf8")).rejects.toHaveProperty("code", "ENOENT");
      releaseWrite();
      await publishing;
      expect((await running).stdout.trim()).toBe("A complete multiword brief.");
    } finally {
      releaseWrite();
      await publishing;
      await running?.catch(() => undefined);
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("releases a waiting worker and rejects an unbounded wait", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "chat-brief-bounded-"));
    try {
      for (const timeout of [0, -1, Infinity, 300_001])
        await expect(prepareChatBrief(directory, "invalid", timeout)).rejects.toThrow("bounded");
      const brief = await prepareChatBrief(directory, "release", 2_000);
      const running = promisify(execFile)(process.execPath, [brief.scriptPath]);
      await expect.poll(() => readFile(brief.ready, "utf8").catch(() => "")).toBe("waiting");
      await publishChatBrief(brief.gate, "Meet at half past ten.");
      expect((await running).stdout.trim()).toBe("Meet at half past ten.");
      const expires = await prepareChatBrief(directory, "expires", 1);
      await expect(promisify(execFile)(process.execPath, [expires.scriptPath])).rejects.toMatchObject({ code: 1 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
