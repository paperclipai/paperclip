import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsNativeOrphan } from "../../__tests__/helpers/windows-native-orphan.js";
import { stopReadOnlyWindowsOrphans } from "./native-windows-orphan-stop.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
describe.runIf(process.platform === "win32")("exact Windows orphan retirement", () => {
  it.each(["owned", "escaped_home", "foreign_parent", "foreign_executable", "foreign_home", "newer_process", "older_process"])(
    "signals only the bound process (%s)", async mode => {
      const root = await mkdtemp(join(tmpdir(), "pc-orphan-test-"));
      const original = await windowsNativeOrphan(root, mode === "escaped_home");
      const input = { ...original };
      if (mode === "foreign_parent") input.parentPid = 99999999;
      if (mode === "foreign_executable") input.executable = join(root, "other.exe");
      if (mode === "foreign_home") input.codexHome = join(root, "other");
      if (mode === "newer_process") { input.notAfter = new Date(Date.parse(original.notBefore) - 1000).toISOString(); input.notBefore = new Date(Date.parse(input.notAfter) - 1000).toISOString(); }
      if (mode === "older_process") { input.notBefore = new Date(Date.parse(original.notAfter) + 1000).toISOString(); input.notAfter = new Date(Date.parse(input.notBefore) + 1000).toISOString(); }
      try {
        const stopped = await stopReadOnlyWindowsOrphans(input);
        if (["owned", "escaped_home"].includes(mode)) {
          expect(stopped).toHaveLength(1);
          expect(stopped![0].pid).toBe(original.pids[0]);
          expect(alive(original.pids[0])).toBe(false);
        } else {
          expect(stopped).toBeNull();
          expect(alive(original.pids[0])).toBe(true);
        }
      } finally {
        await stopReadOnlyWindowsOrphans(original);
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000);
});
