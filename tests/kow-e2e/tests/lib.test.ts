import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newNonce, runDirFor, sshBase, scpBase, freePort,
  writeManifest, readManifest, procAlive, scratchRoot,
  readProcStartTime, manifestPath, type Manifest,
} from "../harness/lib.ts";

let tmpScratch: string;

beforeAll(() => {
  tmpScratch = mkdtempSync(join(tmpdir(), "pkst-test-"));
  process.env.PKST_SCRATCH = tmpScratch;
});

afterAll(() => {
  delete process.env.PKST_SCRATCH;
  rmSync(tmpScratch, { recursive: true, force: true });
});

test("newNonce has the expected shape and is unique", () => {
  const a = newNonce(), b = newNonce();
  expect(a).toMatch(/^r[0-9a-f]{18}$/);
  expect(a).not.toBe(b);
});

test("runDirFor lives under the scratch root and names the nonce", () => {
  const d = runDirFor("rdeadbeef");
  expect(d.startsWith(scratchRoot())).toBe(true);
  expect(d.endsWith("run-rdeadbeef")).toBe(true);
});

test("scratchRoot honours PKST_SCRATCH at call time", () => {
  expect(scratchRoot()).toBe(tmpScratch);
});

test("sshBase uses lowercase -p and ignores system config", () => {
  const a = sshBase(2222, "/k", "/kh");
  expect(a).toContain("-F"); expect(a).toContain("/dev/null");
  expect(a).toEqual(expect.arrayContaining(["-p", "2222", "-i", "/k"]));
  expect(a).toContain("UserKnownHostsFile=/kh");
  expect(a).not.toContain("-P");
});

test("scpBase uses capital -P for the port", () => {
  const a = scpBase(2222, "/k", "/kh");
  expect(a).toEqual(expect.arrayContaining(["-P", "2222"]));
  expect(a).not.toContain("-p");
});

test("freePort returns a usable high port", async () => {
  const p = await freePort();
  expect(p).toBeGreaterThan(1024);
  expect(p).toBeLessThan(65536);
});

test("manifest round-trips and missing reads null", () => {
  const m: Manifest = {
    nonce: "rtest" + Date.now().toString(16), qemuPid: 1, qemuStartTime: 12345, hostfwdPort: 2,
    overlayPath: "/o", runDir: "/r", owner: "claude", startedAt: new Date().toISOString(),
  };
  expect(manifestPath(m.nonce).startsWith(tmpScratch)).toBe(true);
  writeManifest(m);
  expect(readManifest(m.nonce)).toEqual(m);
  expect(readManifest("rnot-a-real-nonce")).toBeNull();
});

test("procAlive reflects reality", () => {
  expect(procAlive(process.pid)).toBe(true);
  expect(procAlive(2147480000)).toBe(false);
});

test("readProcStartTime returns a stable positive value for a live pid", () => {
  const a = readProcStartTime(process.pid);
  expect(typeof a).toBe("number");
  expect(a as number).toBeGreaterThan(0);
  expect(readProcStartTime(process.pid)).toBe(a);
});

test("readProcStartTime returns null for a dead pid", () => {
  expect(readProcStartTime(2147480000)).toBeNull();
});

test("manifestPath lives under the runs dir and names the nonce", () => {
  const p = manifestPath("rdeadbeef");
  expect(p.endsWith("rdeadbeef.json")).toBe(true);
  expect(p.startsWith(scratchRoot())).toBe(true);
});
