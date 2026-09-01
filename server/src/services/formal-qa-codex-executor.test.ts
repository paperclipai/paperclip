import { createHash } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeFormalQaCodexAppServer } from "./formal-qa-codex-executor.js";

const tempDirs: string[] = [];
type CapturedOptions = {
  approvalPolicy?: string;
  environment?: NodeJS.ProcessEnv;
  formalQa?: { contentToolHandler: (call: { tool: "formal_qa_list_files" | "formal_qa_read_file" | "formal_qa_search"; arguments: unknown }) => Promise<unknown> };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Formal-QA Codex executor", () => {
  it("bounds a hung provider, interrupts its accepted turn, and removes its disposable credential home", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "formal-qa-scratch-"));
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "formal-qa-host-home-"));
    tempDirs.push(scratch, hostHome);
    await writeFile(path.join(hostHome, "auth.json"), "{\"fixture\":true}\n", { mode: 0o600 });
    let options: CapturedOptions | null = null;
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const hungEvents = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<never>>(() => {}) };
      },
    };

    await expect(executeFormalQaCodexAppServer({
      runId: "run-1",
      reviewId: "review-1",
      scratchPath: scratch,
      prompt: "sealed prompt",
      model: null,
      timeoutMs: 25,
      environment: { PATH: "/bin", LANG: "C.UTF-8", HOME: hostHome, CODEX_HOME: hostHome },
      sealedContent: {
        list: async () => [],
        read: async () => { throw new Error("unexpected_read"); },
      },
      driverFactory: (input) => {
        options = input;
        return {
          openSession: async () => ({
            startTurn: async () => ({ turnId: "turn-1" }),
            events: () => hungEvents,
            interrupt,
            close,
          }),
        } as never;
      },
    })).rejects.toThrow("formal_qa_codex_timeout");

    expect(interrupt).toHaveBeenCalledWith({ turnId: "turn-1", reason: "formal_qa_codex_timeout" });
    expect(close).toHaveBeenCalledWith({ reason: "formal_qa_terminal", force: true });
    expect(options).not.toBeNull();
    expect(options!.approvalPolicy).toBe("never");
    expect(options!.environment?.HOME).not.toBe(hostHome);
    expect(options!.environment?.CODEX_HOME).toBe(options!.environment?.HOME);
    await expect(access(options!.environment!.HOME!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits only bounded, verified sealed source reads", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "formal-qa-scratch-"));
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "formal-qa-host-home-"));
    tempDirs.push(scratch, hostHome);
    const content = Buffer.from("sealed contents\n", "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    let options: CapturedOptions | null = null;
    const wait = new Promise<void>(() => {});
    const executor = executeFormalQaCodexAppServer({
      runId: "run-2", reviewId: "review-2", scratchPath: scratch, prompt: "sealed", model: null,
      timeoutMs: 25, environment: { PATH: "/bin", HOME: hostHome, CODEX_HOME: hostHome },
      sealedContent: {
        list: async () => [{ path: "README.md", mode: "100644", sha256: digest, size: content.length }],
        read: async (sourcePath) => ({ path: sourcePath, mode: "100644", sha256: digest, size: content.length, content }),
      },
      driverFactory: (input) => {
        options = input;
        return { openSession: async () => ({ startTurn: async () => ({ turnId: "turn-2" }), events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => wait }) }), close: async () => undefined }) } as never;
      },
    });
    while (!options) await new Promise((resolve) => setTimeout(resolve, 1));
    const handler = (options as CapturedOptions).formalQa!.contentToolHandler;
    await expect(handler({ tool: "formal_qa_read_file", arguments: { path: "../auth.json" } })).rejects.toThrow("path_invalid");
    await expect(handler({ tool: "formal_qa_read_file", arguments: { path: "README.md", extra: true } })).rejects.toThrow("arguments_invalid");
    await expect(handler({ tool: "formal_qa_read_file", arguments: { path: "README.md" } })).resolves.toMatchObject({ content: "sealed contents\n", sha256: digest });
    await expect(executor).rejects.toThrow("formal_qa_codex_timeout");
  });
});
