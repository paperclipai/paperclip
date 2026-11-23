import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceInventory } from "./remote-workspace-readonly-inventory.js";

const exec = promisify(execFile);

describe("workspace inventory cancellation", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "workspace-inventory-abort-")));
    await fs.writeFile(path.join(root, "saved.txt"), "preserve this result\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    { controllerCopy: false, timing: "before_stream" },
    { controllerCopy: true, timing: "before_stream" },
    { controllerCopy: false, timing: "during_read" },
    { controllerCopy: true, timing: "during_read" },
  ])("keeps the process alive after cancellation ($timing, controller copy: $controllerCopy)", async ({ controllerCopy, timing }) => {
    const source = readWorkspaceInventory.toString().replaceAll("__vite_ssr_dynamic_import__", "import");
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const __name = value => value;
      const inspect = ${source};
      const root = process.argv[1];
      const file = root + '/saved.txt';
      const controller = new AbortController();
      const reason = new DOMException('Capture deadline expired', 'TimeoutError');
      const realpath = fs.realpath;
      let armed = false;
      fs.realpath = async (...args) => {
        const resolved = await realpath(...args);
        if (args[0] === file && !armed) {
          armed = true;
          if (${JSON.stringify(timing)} === 'before_stream') controller.abort(reason);
          else setImmediate(() => controller.abort(reason));
        }
        return resolved;
      };
      syncBuiltinESMExports();
      let rejected = false;
      try {
        await inspect(root, ${controllerCopy}, controller.signal);
      } catch (error) {
        assert.ok(error === reason || error.cause === reason);
        rejected = true;
      } finally {
        fs.realpath = realpath;
        syncBuiltinESMExports();
      }
      assert.equal(rejected, true);
      await new Promise(resolve => setImmediate(resolve));
      const saved = await inspect(root, ${controllerCopy});
      assert.equal(await fs.readFile(file, 'utf8'), 'preserve this result\\n');
      process.stdout.write(JSON.stringify(saved));
    `;
    const result = await exec(process.execPath, ["--input-type=module", "-e", script, root], { timeout: 5000 });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ entries: 1, byteSize: 21 });
  });
});
