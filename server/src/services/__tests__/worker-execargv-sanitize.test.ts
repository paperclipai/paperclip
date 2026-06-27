import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { sanitizeWorkerExecArgv } from "../plugin-worker-manager.js";

/**
 * Regression test for NEO-274: a plugin worker's loader exec flag is captured
 * once at registration and reused on every autoRestart. If the loader file
 * later vanishes (e.g. an SSH sync-back repoints the tsx loader symlink at a
 * /tmp dir that is then cleaned up), each restart must drop the dead flag and
 * spawn without it rather than crash-loop on ERR_MODULE_NOT_FOUND.
 */
describe("sanitizeWorkerExecArgv (NEO-274)", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps --import when the loader file exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neo274-loader-"));
    cleanupDirs.push(dir);
    const loader = path.join(dir, "loader.mjs");
    await writeFile(loader, "export {}");

    expect(sanitizeWorkerExecArgv(["--import", loader])).toEqual(["--import", loader]);
  });

  it("drops --import (two-token) when the loader file is missing", () => {
    const missing = "/tmp/paperclip-ssh-sync-back-GONE/cli/node_modules/tsx/dist/loader.mjs";
    const dropped: Array<[string, string]> = [];
    const result = sanitizeWorkerExecArgv(
      ["--import", missing, "--enable-source-maps"],
      (flag, value) => dropped.push([flag, value]),
    );
    expect(result).toEqual(["--enable-source-maps"]);
    expect(dropped).toEqual([["--import", missing]]);
  });

  it("drops inline --loader=<missing> form", () => {
    const missing = "/tmp/paperclip-ssh-sync-back-GONE/loader.mjs";
    expect(sanitizeWorkerExecArgv([`--loader=${missing}`])).toEqual([]);
  });

  it("resolves file:// loader URLs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neo274-loader-url-"));
    cleanupDirs.push(dir);
    const loader = path.join(dir, "loader.mjs");
    await writeFile(loader, "export {}");
    const url = pathToFileURL(loader).href;

    expect(sanitizeWorkerExecArgv(["--import", url])).toEqual(["--import", url]);
    expect(sanitizeWorkerExecArgv(["--import", "file:///nope/missing.mjs"])).toEqual([]);
  });

  it("leaves non-loader flags untouched", () => {
    expect(
      sanitizeWorkerExecArgv(["--max-old-space-size=512", "--enable-source-maps"]),
    ).toEqual(["--max-old-space-size=512", "--enable-source-maps"]);
  });
});
