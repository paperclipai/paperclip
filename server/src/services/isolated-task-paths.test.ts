import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { isolatedTaskPathSegments, readIsolatedTaskPath, resolveIsolatedTaskDirectory } from "./isolated-task-paths.js";
import { materializeIsolatedTaskDirectory } from "./isolated-task-directory.js";

import { isolatedTaskSourceIdentity } from "./workspace-source-lock.js";

const identity = { companyId: "10000000-0000-4000-8000-000000000001", issueId: "20000000-0000-4000-8000-000000000002", attemptId: "30000000-0000-4000-8000-000000000003" };
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("round-trips Windows identities without case-sensitive directory names", () => {
  const root = path.resolve("instance");
  const parts = isolatedTaskPathSegments(identity, "win32");
  expect(parts[0]).toBe("w");
  expect(parts.slice(1).every(part => /^[0-9a-z]{25}$/.test(part))).toBe(true);
  expect(readIsolatedTaskPath(root, path.join(root, ...parts, "w", "nested"))).toMatchObject({ ...identity, compact: true, rest: ["w", "nested"] });
  const other = isolatedTaskPathSegments({ ...identity, issueId: "20000000-0000-4000-8000-000000000003" }, "win32");
  expect(other.join("/").toLowerCase()).not.toBe(parts.join("/").toLowerCase());
});
it("keeps POSIX paths and legacy identifiers unchanged", () => {
  expect(isolatedTaskPathSegments(identity, "linux")).toEqual(["isolated-workspace-attempts", identity.companyId, identity.issueId, identity.attemptId]);
  expect(isolatedTaskPathSegments({ companyId: "company", issueId: "task", attemptId: "attempt" }, "win32")).toEqual(["isolated-workspace-attempts", "company", "task", "attempt"]);
});
it.each(["z".repeat(25), "A".repeat(25), "short", ".."])("rejects an invalid compact identity: %s", value => {
  const root = path.resolve("instance");
  const parts = isolatedTaskPathSegments(identity, "win32");
  expect(readIsolatedTaskPath(root, path.join(root, "w", value, ...parts.slice(2)))).toBeNull();
});
it("keeps a legacy attempt in place without losing its files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pc-paths-")); roots.push(home);
  const legacy = path.join(home, ...isolatedTaskPathSegments(identity, "linux"));
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "saved.txt"), "keep me");
  expect(await resolveIsolatedTaskDirectory(home, identity)).toBe(legacy);
  expect(await readFile(path.join(legacy, "saved.txt"), "utf8")).toBe("keep me");
});
it.skipIf(process.platform !== "win32")("reuses compact attempts only for their original task and company", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pc-paths-")); roots.push(home);
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  const cwd = await materializeIsolatedTaskDirectory(identity);
  await writeFile(path.join(cwd, "saved.txt"), "keep me");
  expect(await materializeIsolatedTaskDirectory({ companyId: identity.companyId, issueId: identity.issueId, reuseCwd: cwd })).toBe(cwd);
  for (const other of [{ companyId: identity.issueId, issueId: identity.issueId }, { companyId: identity.companyId, issueId: identity.companyId }]) {
    await expect(materializeIsolatedTaskDirectory({ ...other, reuseCwd: cwd })).rejects.toThrow("not this task");
  }
  expect(await readFile(path.join(cwd, "saved.txt"), "utf8")).toBe("keep me");
});

it.skipIf(process.platform !== "win32")("retains source admission ownership for compact attempts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pc-paths-")); roots.push(home);
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  const cwd = await materializeIsolatedTaskDirectory(identity);
  expect(await isolatedTaskSourceIdentity(identity.companyId, cwd)).toBe(identity.issueId);
  await expect(isolatedTaskSourceIdentity(identity.issueId, cwd)).rejects.toThrow("company_mismatch");
});
it.skipIf(process.platform !== "win32")("rejects a junction and preserves the other task's files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pc-paths-")); roots.push(home);
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  const other = await materializeIsolatedTaskDirectory({ ...identity, issueId: identity.attemptId });
  await writeFile(path.join(other, "saved.txt"), "other task");
  const cwd = await resolveIsolatedTaskDirectory(path.join(home, "instances", "default"), identity);
  await mkdir(path.dirname(cwd), { recursive: true });
  await symlink(other, cwd, "junction");
  await expect(materializeIsolatedTaskDirectory(identity)).rejects.toThrow("not a private directory");
  expect(await readFile(path.join(other, "saved.txt"), "utf8")).toBe("other task");
});
it.skipIf(process.platform !== "win32")("refuses to choose between two existing roots for the same attempt", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pc-paths-")); roots.push(home);
  const preferred = path.join(home, ...isolatedTaskPathSegments(identity, "win32"));
  const legacy = path.join(home, ...isolatedTaskPathSegments(identity, "linux"));
  await mkdir(preferred, { recursive: true }); await mkdir(legacy, { recursive: true });
  await writeFile(path.join(legacy, "saved.txt"), "keep me");
  await expect(resolveIsolatedTaskDirectory(home, identity)).rejects.toThrow("Ambiguous");
  expect(await readFile(path.join(legacy, "saved.txt"), "utf8")).toBe("keep me");
});
