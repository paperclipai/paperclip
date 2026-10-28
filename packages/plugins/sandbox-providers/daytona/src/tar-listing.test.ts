import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./plugin.js", () => ({ getPluginTracer: () => undefined }));
import { environmentSyncErrorData, withEnvironmentSyncErrorCapture, withEnvironmentSyncTransferStep, readEnvironmentSyncErrorDiagnostic } from "@paperclipai/plugin-sdk";
import { assertTarballEntriesConfined } from "./file-sync.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function temporaryDirectory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-tar-listing-"));
  temporaryDirectories.push(dir);
  return dir;
}

// Empty USTAR members are sufficient to exercise the real host tar listing.
// Repeating a member is valid tar and avoids creating 145,000 host files just
// to reproduce the archive metadata buffer limit.
function tarHeader(name: string, prefix = "", target?: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write("00000000000\0", 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(target === undefined ? "0" : "2", 156);
  if (target !== undefined) header.write(target, 157, 100);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(prefix, 345, 155);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

it.each([false, true])("validates every member beyond 32 MiB of real tar names (unsafe suffix: %s)", async (unsafeSuffix) => {
  const archive = path.join(await temporaryDirectory(), "large.tar");
  const prefix = "nested-".repeat(21);
  const name = "asset-".repeat(15);
  const count = 145_000;
  expect((prefix.length + 1 + name.length) * count).toBeGreaterThan(32 * 1024 * 1024);
  const header = tarHeader(name, prefix);
  const batch = Buffer.concat(Array.from({ length: 1_000 }, () => header));
  const file = await fs.open(archive, "w");
  try {
    for (let written = 0; written < count; written += 1_000) await file.write(batch);
    if (unsafeSuffix) await file.write(tarHeader("escape", "", "../../outside"));
    await file.write(Buffer.alloc(1_024));
  } finally {
    await file.close();
  }
  if (unsafeSuffix) {
    await expect(assertTarballEntriesConfined(archive)).rejects.toThrow("link whose target escapes");
  } else {
    await expect(assertTarballEntriesConfined(archive)).resolves.toBeUndefined();
  }
}, 30_000);

async function fakeTar(script: string) {
  const directory = await temporaryDirectory();
  const pidFile = path.join(directory, "pid");
  await fs.writeFile(path.join(directory, "tar"), `#!${process.execPath}\n` +
    `require("node:fs").appendFileSync(${JSON.stringify(pidFile)}, String(process.pid) + "\\n");\n${script}\n`, { mode: 0o755 });
  vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH}`);
  return async () => {
    const pids = (await fs.readFile(pidFile, "utf8")).trim().split("\n").map(Number);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  };
}

const safeLine = "-rw-r--r-- 0/0 0 2026-09-27 12:00 nested/café.txt";

// The child streams batches with pipe backpressure; quota tests do not allocate
// a complete oversized listing in either the parent or the child.
function listingWriter(line: string, count: number, tail = "") {
  return `
    const { once } = require("node:events");
    const line = Buffer.from(${JSON.stringify(line)});
    (async () => {
      let left = ${count};
      while (left > 0) {
        const size = Math.min(left, Math.max(1, Math.floor(65536 / line.length)));
        const batch = Buffer.concat(Array.from({ length: size }, () => line));
        if (!process.stdout.write(batch)) await once(process.stdout, "drain");
        left -= size;
      }
      process.stdout.write(${JSON.stringify(tail)});
    })();
  `;
}

it.each([false, true])("bounds aggregate listing bytes at 64 MiB (over quota: %s)", async (overQuota) => {
  const line = "-rw-r--r-- 0/0 0 2026-09-27 12:00 ".padEnd(4095, "x") + "\n";
  const count = 64 * 1024 * 1024 / Buffer.byteLength(line) + Number(overQuota);
  const checkReaped = await fakeTar(listingWriter(line, count));
  await withEnvironmentSyncErrorCapture(async () => {
    const result = assertTarballEntriesConfined("unused.tar");
    if (overQuota) {
      const error = await result.catch(error => error);
      expect(error.message).toContain("total listing byte limit");
      expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(error) })?.transferFailureKind).toBe("listing_byte_limit");
    } else await expect(result).resolves.toBeUndefined();
  });
  await checkReaped();
}, 30_000);

it.each([false, true])("bounds aggregate listing entries at 250,000 (over quota: %s)", async (overQuota) => {
  // The over-quota member has no newline: EOF must pass the same admission gate.
  const checkReaped = await fakeTar(listingWriter(safeLine + "\n", 250_000, overQuota ? safeLine : ""));
  await withEnvironmentSyncErrorCapture(async () => {
    const result = assertTarballEntriesConfined("unused.tar");
    if (overQuota) {
      const error = await result.catch(error => error);
      expect(error.message).toContain("listing entry limit");
      expect(readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(error) })?.transferFailureKind).toBe("listing_entry_limit");
    } else await expect(result).resolves.toBeUndefined();
  });
  await checkReaped();
}, 30_000);

it("counts blank lines against the aggregate parsing quota", async () => {
  const checkReaped = await fakeTar(listingWriter("\n", 250_001));
  await expect(assertTarballEntriesConfined("unused.tar")).rejects.toThrow("listing entry limit");
  await checkReaped();
});

it("enforces quotas independently on repeated and concurrent listings and reaps every child", async () => {
  const checkReaped = await fakeTar(`
    if (process.argv[3] === "small.tar") process.stdout.write(${JSON.stringify(safeLine + "\n")});
    else { ${listingWriter(safeLine + "\n", 250_001)} }
  `);
  const results = await Promise.allSettled([
    assertTarballEntriesConfined("large-a.tar"),
    assertTarballEntriesConfined("small.tar"),
    assertTarballEntriesConfined("large-b.tar"),
  ]);
  expect(results[0]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("listing entry limit") }) });
  expect(results[1]).toMatchObject({ status: "fulfilled" });
  expect(results[2]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("listing entry limit") }) });
  await expect(assertTarballEntriesConfined("large-again.tar")).rejects.toThrow("listing entry limit");
  await checkReaped();
}, 30_000);
it("preserves UTF-8 split across chunks and checks a final line without a newline", async () => {
  const checkReaped = await fakeTar(`
    const bytes = Buffer.from(${JSON.stringify(safeLine)});
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 30);
  `);
  await expect(assertTarballEntriesConfined("unused.tar")).resolves.toBeUndefined();
  await checkReaped();
});

it.each([
  "not a tar listing",
  "-rw-r--r-- 0/0 0 2026-09-27 12:00 ../escape",
  "lrwxrwxrwx 0/0 0 2026-09-27 12:00 link -> /outside",
  "hrw-r--r-- 0/0 0 2026-09-27 12:00 link link to ../../outside",
  "lrwxrwxrwx 0/0 0 2026-09-27 12:00 link -> decoy -> ../../outside",
])("rejects an unsafe final listing and reaps the child: %s", async (line) => {
  const checkReaped = await fakeTar(`process.stdout.write(${JSON.stringify(line)});`);
  await expect(assertTarballEntriesConfined("unused.tar")).rejects.toThrow("Daytona syncOut refusing");
  await checkReaped();
});

it("bounds an unterminated entry instead of buffering it indefinitely", async () => {
  const checkReaped = await fakeTar(`process.stdout.write("x".repeat(65_537)); setInterval(() => {}, 1_000);`);
  await expect(assertTarballEntriesConfined("unused.tar")).rejects.toThrow("entry listing exceeding the byte limit");
  await checkReaped();
});

it("bounds stderr and reaps a noisy tar process", async () => {
  const checkReaped = await fakeTar(`process.stderr.write("x".repeat(65_537)); setInterval(() => {}, 1_000);`);
  await expect(assertTarballEntriesConfined("unused.tar")).rejects.toThrow("diagnostics exceed the byte limit");
  await checkReaped();
});

it("rejects nonzero tar exit even after a valid listing", async () => {
  const checkReaped = await fakeTar(`process.stdout.write(${JSON.stringify(safeLine + "\n")}); process.exitCode = 2;`);
  await expect(assertTarballEntriesConfined("unused.tar")).rejects.toThrow("tar listing failed (2)");
  await checkReaped();
});

it("times out and reaps a stalled listing process", async () => {
  const checkReaped = await fakeTar(`setInterval(() => {}, 1_000);`);
  // Leave enough startup time for the PID witness under parallel test load.
  await expect(assertTarballEntriesConfined("unused.tar", 2_000)).rejects.toThrow("timed out");
  await checkReaped();
});

it("rejects spawn failures without hanging", async () => {
  vi.stubEnv("PATH", await temporaryDirectory());
  await expect(assertTarballEntriesConfined("unused.tar")).rejects.toThrow("ENOENT");
});


it.each([
  ["process.exitCode = 2;", "command_failed", 2, "unknown"],
  ['process.stdout.write("x".repeat(65_537)); setInterval(() => {}, 1_000);', "listing_line_limit", undefined, "unknown"],
  ['process.stderr.write("x".repeat(65_537)); setInterval(() => {}, 1_000);', "listing_stderr_limit", undefined, "unknown"],
  ['process.stdout.write("invalid-private-listing");', "unsafe_archive", undefined, "unknown"],
  ['setInterval(() => {}, 1_000);', "listing_timeout", undefined, "ETIMEDOUT"],
] as const)("records bounded listing evidence and reaps the child (%s)", async (script, kind, exitCode, errorCode) => {
  const checkReaped = await fakeTar(script);
  await withEnvironmentSyncErrorCapture(async () => {
    let caught: unknown;
    try { await withEnvironmentSyncTransferStep("archive_validate", () => assertTarballEntriesConfined("private-archive.tar", 2_000)); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const diagnostic = readEnvironmentSyncErrorDiagnostic({ data: environmentSyncErrorData(caught) });
    expect(diagnostic).toEqual({ errorCode, transferStep: "archive_validate", transferFailureKind: kind,
      ...(exitCode !== undefined ? { exitCode } : {}),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
  });
  await checkReaped();
});
