import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as diagnostics from "./test-postgres-diagnostics.js";
import {
  __setEmbeddedPostgresCtorProviderForTests as setCtor,
  __startEmbeddedPostgresWithRetryForTests as startFresh,
  __startEmbeddedPostgresFromTemplateWithRetryForTests as startTemplate,
  __embeddedPostgresStartMaxAttemptsForTests as maxAttempts,
} from "./test-embedded-postgres.js";

const realCapture = diagnostics.captureMacPostgresDiagnostics;
const log =
  "FATAL: could not create shared memory segment: No space left on device";
const paths: string[] = [];

function captureReceipts() {
  const emit = vi.fn();
  const capture = vi
    .spyOn(diagnostics, "captureMacPostgresDiagnostics")
    .mockImplementation((input) =>
      realCapture(input, {
        platform: "darwin",
        emit,
        runCommand: async (command, args) => ({
          command,
          args,
          stdout: "",
          stderr: "simulated unavailable macOS host utility",
          status: "incomplete",
          error: "ENOENT",
        }),
      }),
    );
  return { emit, capture };
}

function fakeCtor(failures: number, initialiseFails = false) {
  const dirs: string[] = [];
  const receiptCountsAtStop: number[] = [];
  let starts = 0;
  class FakePostgres {
    process: { pid: number; exitCode: number; signalCode: null } | undefined;
    constructor(
      private options: {
        databaseDir: string;
        onLog?: (message: unknown) => void;
      },
    ) {
      dirs.push(options.databaseDir);
    }
    async initialise() {
      if (initialiseFails) {
        this.options.onLog?.(log);
        throw new Error("initdb-original");
      }
    }
    async start() {
      this.process = { pid: 99999999, exitCode: 1, signalCode: null };
      starts += 1;
      if (starts <= failures) {
        this.options.onLog?.(`${log}\nattempt-${starts}`);
        throw new Error(`startup-original-${starts}`);
      }
    }
    async stop() {
      const receipts = paths.flatMap((dir) =>
        fs.existsSync(dir) ? fs.readdirSync(dir) : [],
      );
      receiptCountsAtStop.push(receipts.length);
    }
  }
  return { ctor: FakePostgres, dirs, receiptCountsAtStop };
}

function watchReceiptPaths() {
  const original = fs.writeFileSync;
  vi.spyOn(fs, "writeFileSync").mockImplementation((file, ...args) => {
    if (typeof file === "string" && file.endsWith("/receipt.json"))
      paths.push(path.dirname(file));
    return original(file, ...args);
  });
}

describe("diagnostics through existing startup retries", () => {
  afterEach(() => {
    setCtor(null);
    vi.restoreAllMocks();
    for (const dir of paths.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["fresh", "template"])(
    "preserves the failed %s attempt after a successful retry and data cleanup",
    async (mode) => {
      watchReceiptPaths();
      const { emit, capture } = captureReceipts();
      const fake = fakeCtor(1);
      setCtor(async () => fake.ctor);
      const template = fs.mkdtempSync(
        path.join(os.tmpdir(), "paperclip-diagnostic-template-"),
      );
      fs.writeFileSync(path.join(template, "PG_VERSION"), "18\n");
      try {
        const started =
          mode === "fresh"
            ? await startFresh("paperclip-diagnostic-fresh-")
            : await startTemplate(template, "paperclip-diagnostic-copy-");
        try {
          expect(fake.dirs).toHaveLength(2);
          expect(fake.receiptCountsAtStop).toEqual([1]);
          expect(fs.existsSync(fake.dirs[0])).toBe(false);
          expect(paths).toHaveLength(1);
          const receiptFile = path.join(paths[0], "receipt.json");
          const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
          expect(receipt.originalFailure.message).toBe("startup-original-1");
          expect(receipt.recentLogs).toContain("attempt-1");
          expect(receipt.phase).toBe("start");
          expect(receipt.attempt).toBe(1);
          expect(receipt.recordedProcess).toMatchObject({
            harnessPid: process.pid,
            postgresPid: 99999999,
            exitCode: 1,
          });
          expect(receipt.completeness).toBe("incomplete");
          expect(capture).toHaveBeenCalledOnce();
          expect(emit.mock.calls[0][0]).toContain(receiptFile);
          if (process.platform !== "win32") {
            expect(fs.statSync(paths[0]).mode & 0o777).toBe(0o700);
            expect(fs.statSync(receiptFile).mode & 0o777).toBe(0o600);
          }
        } finally {
          await started.instance.stop();
          fs.rmSync(started.dataDir, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(template, { recursive: true, force: true });
      }
    },
  );

  it("keeps the original failure and every receipt at the unchanged attempt bound", async () => {
    watchReceiptPaths();
    captureReceipts();
    const fake = fakeCtor(Infinity, true);
    setCtor(async () => fake.ctor);
    await expect(startFresh("paperclip-diagnostic-exhausted-")).rejects.toThrow(
      `after ${maxAttempts} attempts: initdb-original`,
    );
    expect(fake.dirs).toHaveLength(maxAttempts);
    expect(paths).toHaveLength(maxAttempts);
    expect(fake.receiptCountsAtStop).toEqual(
      Array.from({ length: maxAttempts }, (_, index) => index + 1),
    );
    for (const dir of fake.dirs) expect(fs.existsSync(dir)).toBe(false);
    for (let index = 0; index < paths.length; index += 1) {
      const receipt = JSON.parse(
        fs.readFileSync(path.join(paths[index], "receipt.json"), "utf8"),
      );
      expect(receipt).toMatchObject({
        attempt: index + 1,
        phase: "initialise",
        originalFailure: { message: "initdb-original" },
      });
      expect(receipt.recordedProcess.postgresPid).toBeNull();
      expect(receipt.incompleteReasons.join(" ")).toContain(
        "identity was not recorded",
      );
    }
  });
});
