import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeFormalQaCodexAppServer,
  formalQaCodexExecutorTestOnly,
} from "./formal-qa-codex-executor.js";

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
  it("allows instance scratch under HOME while rejecting scratch inside the Codex credential home", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "formal-qa-home-"));
    const codexHome = path.join(home, ".codex");
    const instanceScratch = path.join(home, ".paperclip/instances/default/formal-qa-review-scratch");
    const credentialScratch = path.join(codexHome, "formal-qa-review-scratch");
    tempDirs.push(home);
    await mkdir(instanceScratch, { recursive: true });
    await mkdir(credentialScratch, { recursive: true });
    const environment = { HOME: home, CODEX_HOME: codexHome };

    await expect(formalQaCodexExecutorTestOnly.assertScratchCredentialSeparation(
      instanceScratch, environment,
    )).resolves.toBeUndefined();
    await expect(formalQaCodexExecutorTestOnly.protectedRoots(environment)).resolves.toEqual([codexHome]);
    await expect(formalQaCodexExecutorTestOnly.assertScratchCredentialSeparation(
      credentialScratch, environment,
    )).rejects.toThrow("formal_qa_scratch_credential_overlap");
  });

  it("protects the resolved ~/.codex credential home when CODEX_HOME is not explicit", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "formal-qa-home-"));
    const codexHome = path.join(home, ".codex");
    const credentialScratch = path.join(codexHome, "review");
    tempDirs.push(home);
    await mkdir(credentialScratch, { recursive: true });
    const environment = { HOME: home };
    await expect(formalQaCodexExecutorTestOnly.protectedRoots(environment)).resolves.toEqual([codexHome]);
    await expect(formalQaCodexExecutorTestOnly.assertScratchCredentialSeparation(
      credentialScratch, environment,
    )).rejects.toThrow("formal_qa_scratch_credential_overlap");
  });

  it("rejects a credential symlink that aliases the trusted scratch tree", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "formal-qa-home-"));
    const instanceScratch = path.join(home, ".paperclip/instances/default/formal-qa-review-scratch");
    const codexHome = path.join(home, ".codex");
    tempDirs.push(home);
    await mkdir(instanceScratch, { recursive: true });
    await symlink(instanceScratch, codexHome, "dir");

    await expect(formalQaCodexExecutorTestOnly.assertScratchCredentialSeparation(
      instanceScratch, { HOME: home, CODEX_HOME: codexHome },
    )).rejects.toThrow("formal_qa_scratch_credential_overlap");
  });

  it("interrupts and force-closes a live turn when the control plane aborts it", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "formal-qa-scratch-"));
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "formal-qa-host-home-"));
    tempDirs.push(scratch, hostHome);
    const controller = new AbortController();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    let turnStarted = false;
    const execution = executeFormalQaCodexAppServer({
      runId: "run-cancel", reviewId: "review-cancel", scratchPath: scratch, prompt: "sealed", model: null,
      timeoutMs: 5_000, signal: controller.signal,
      environment: { PATH: "/bin", HOME: hostHome, CODEX_HOME: hostHome },
      sealedContent: { list: async () => [], read: async () => { throw new Error("unexpected_read"); } },
      driverFactory: () => ({
        openSession: async () => ({
          startTurn: async () => { turnStarted = true; return { turnId: "turn-cancel" }; },
          events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) }),
          interrupt,
          close,
        }),
      }) as never,
    });
    while (!turnStarted) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error("board_cancelled"));
    await expect(execution).rejects.toThrow("board_cancelled");
    expect(interrupt).toHaveBeenCalledWith({ turnId: "turn-cancel", reason: "formal_qa_codex_cancelled" });
    expect(close).toHaveBeenCalledWith({ reason: "formal_qa_terminal", force: true });
  });

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

  it("rejects malformed UTF-8 instead of reviewing replacement characters", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "formal-qa-scratch-"));
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "formal-qa-host-home-"));
    tempDirs.push(scratch, hostHome);
    const content = Buffer.from([0x66, 0x6f, 0x80, 0x6f]);
    const digest = createHash("sha256").update(content).digest("hex");
    let options: CapturedOptions | null = null;
    const wait = new Promise<void>(() => {});
    const executor = executeFormalQaCodexAppServer({
      runId: "run-invalid-utf8", reviewId: "review-invalid-utf8", scratchPath: scratch,
      prompt: "sealed", model: null, timeoutMs: 25,
      environment: { PATH: "/bin", HOME: hostHome, CODEX_HOME: hostHome },
      sealedContent: {
        list: async () => [{ path: "src/bad.ts", mode: "100644", sha256: digest, size: content.length }],
        read: async (sourcePath) => ({ path: sourcePath, mode: "100644", sha256: digest, size: content.length, content }),
      },
      driverFactory: (input) => {
        options = input;
        return { openSession: async () => ({ startTurn: async () => ({ turnId: "turn-invalid-utf8" }), events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => wait }) }), close: async () => undefined }) } as never;
      },
    });
    while (!options) await new Promise((resolve) => setTimeout(resolve, 1));
    const handler = (options as CapturedOptions).formalQa!.contentToolHandler;
    await expect(handler({ tool: "formal_qa_read_file", arguments: { path: "src/bad.ts" } }))
      .rejects.toThrow("formal_qa_content_tool_binary_file");
    await expect(handler({ tool: "formal_qa_search", arguments: { query: "foo" } }))
      .rejects.toThrow("formal_qa_content_tool_binary_file");
    await expect(executor).rejects.toThrow("formal_qa_codex_timeout");
  });
});
