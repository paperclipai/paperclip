import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import type { NativeProviderArtifactSource } from "./native-provider-artifacts.js";
import { NativeExecutionContext } from "./native-execution-context.js";
import { captureRemoteNativeProviderArtifacts } from "./native-provider-artifact-capture.js";

afterEach(() => vi.useRealTimers());
it.each(["stop", "deadline"])(
  "bounds %s while retaining the actual late transfer and scratch owner",
  async (mode) => {
    vi.useFakeTimers();
    const context = new NativeExecutionContext(
      {
        binding: {
          companyId: randomUUID(),
          runId: randomUUID(),
          agentId: randomUUID(),
        },
      } as NativeExecutionInput,
      1_000,
    );
    let release!: () => void,
      entered!: () => void,
      root = "",
      outcome = "pending";
    const gate = new Promise<void>((done) => {
        release = done;
      }),
      started = new Promise<void>((done) => {
        entered = done;
      });
    const runner = {
      // The confined export staging and its cleanup run as sandbox commands.
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: null,
      })),
      syncOut: async (operations) => {
        const destination = operations[0].files[0].targetPath;
        root = dirname(destination);
        await writeFile(destination, "partial qualified download");
        entered();
        await gate;
        await writeFile(destination, "late qualified download finished");
        return { operations: [] };
      },
    } as CommandManagedRuntimeRunner;
    const manifest = {
      payload: {
        artifacts: Object.fromEntries(
          ["nodeCommand", "opencodeProxy", "opencodeExecutable"].map((name) => [
            name,
            { path: name },
          ]),
        ),
      },
    } as NativeProviderArtifactSource["manifest"];
    const publish = vi.fn(async () => "must not publish");
    const result = captureRemoteNativeProviderArtifacts(
      {
        runner,
        remoteCwd: "/workspace",
        manifest,
        context,
        signal: context.signal,
        launch: {
          root: "/owned/qualified",
          accountUid: 1000,
          paths: {
            nodeCommand: "/qualified/node",
            opencodeProxy: "/qualified/proxy",
            opencodeExecutable: "/qualified/opencode",
          },
        },
      },
      publish,
    ).then(
      () => {
        outcome = "published";
      },
      (error) => {
        outcome = error.message;
      },
    );
    try {
      await started;
      if (mode === "stop") context.abort(new Error("controlled Stop"));
      await vi.advanceTimersByTimeAsync(mode === "deadline" ? 1_000 : 0);
      expect(outcome).toBe(
        mode === "stop"
          ? "controlled Stop"
          : "native_execution_startup_expired",
      );
      expect(context.pending).toBe(true);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      release();
      await result;
      vi.useRealTimers();
      await vi.waitFor(() => expect(context.pending).toBe(false), {
        timeout: 1_000,
        interval: 5,
      });
      context.finish();
    }
    expect(context.pending).toBe(false);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(publish).not.toHaveBeenCalled();
  },
);
