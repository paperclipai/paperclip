import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fetchGitBundleIntoLocalRef, runLocalGit } from "./git-workspace-sync.js";

const timing = vi.hoisted(() => ({ enabled: false, elapsedProbeMs: 0, probeDurationMs: 14_000, fetchTimeout: 0 }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: (...args: Parameters<typeof actual.execFile>) => {
    const gitArgs = args[1] as string[];
    if (timing.enabled && gitArgs.includes("fetch")) timing.fetchTimeout = Number((args[2] as { timeout: number }).timeout);
    // Keep real Git and its callbacks. Only its observed probe duration is
    // controlled, so a fast fixture can exercise a nearly spent probe budget.
    if (timing.enabled && gitArgs.some(arg => arg.endsWith("^@"))) {
      const callback = args[3] as (...values: unknown[]) => void;
      args[3] = ((...values: unknown[]) => { timing.elapsedProbeMs += timing.probeDurationMs; callback(...values); }) as typeof args[3];
    }
    return actual.execFile(...args);
  } };
});

it.each([14_000, 16_000])("separates transfer and probe budgets (probe duration %s)", async probeDurationMs => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-probe-budget-"));
  const git = async (cwd: string, args: string[]) => (await runLocalGit(cwd, args)).stdout.trim();
  const realNow = Date.now.bind(Date);
  try {
    const source = path.join(root, "source"), host = path.join(root, "host"), remote = path.join(root, "remote");
    await git(root, ["init", source]);
    await git(source, ["config", "user.name", "Test"]);
    await git(source, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(source, "saved.txt"), "base\n");
    await git(source, ["add", "."]); await git(source, ["commit", "-m", "base"]);
    await git(root, ["clone", source, host]);
    await writeFile(path.join(source, "saved.txt"), "completed\n");
    await git(source, ["commit", "-am", "completed"]);
    const head = await git(source, ["rev-parse", "HEAD"]);
    await git(root, ["clone", "--depth=1", `file://${source}`, remote]);
    const bundlePath = path.join(root, "work.bundle"), shallowPath = path.join(remote, ".git", "shallow");
    const exportRef = `refs/paperclip/export/${randomUUID()}`, importedRef = `refs/paperclip/import/${randomUUID()}`;
    await git(remote, ["update-ref", exportRef, head]);
    await git(remote, ["bundle", "create", bundlePath, exportRef]);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + timing.elapsedProbeMs);
    timing.enabled = true; timing.probeDurationMs = probeDurationMs;
    if (probeDurationMs > 15_000) {
      await expect(fetchGitBundleIntoLocalRef({ localDir: host, bundlePath, shallowPath, exportRef, importedRef, baseSha: head }))
        .rejects.toThrow("boundary inspection timed out");
      expect(timing.fetchTimeout).toBe(0);
      timing.enabled = false;
      await expect(git(host, ["rev-parse", "--verify", importedRef])).rejects.toThrow();
      expect(await readFile(path.join(host, "saved.txt"), "utf8")).toBe("base\n");
      return;
    }
    expect(await fetchGitBundleIntoLocalRef({ localDir: host, bundlePath, shallowPath, exportRef, importedRef, baseSha: head })).toBe(head);
    expect(timing.elapsedProbeMs).toBe(14_000);
    expect(timing.fetchTimeout).toBeGreaterThan(55_000);
    timing.enabled = false;
    expect(await git(host, ["show", `${importedRef}:saved.txt`])).toBe("completed");
    expect(await git(host, ["fsck", "--connectivity-only"])).not.toContain("missing");
    expect(await readFile(path.join(host, "saved.txt"), "utf8")).toBe("base\n");
  } finally {
    timing.enabled = false; timing.elapsedProbeMs = 0; timing.fetchTimeout = 0;
    vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
  }
});
