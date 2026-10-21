import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const loader = fileURLToPath(new URL("./composer-stop-codex-loader.mjs", import.meta.url));
const resolver = new URL("../../../packages/paperclip-runner/src/drivers/codex/codex-command.ts", import.meta.url).href;
function launch(env, source = "") {
  return spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", source], {
    encoding: "utf8", env: { ...process.env, NODE_ENV: "test", PAPERCLIP_STOP_CODEX_COMMAND: "", ...env },
  });
}

test("pins the fixture even when a bundled Codex dependency is installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "composer-stop-loader-"));
  const command = join(dir, "codex");
  try {
    writeFileSync(command, "#!/bin/sh\nprintf 'composer-stop-fixture'\n", { mode: 0o755 });
    const result = launch({ PAPERCLIP_STOP_CODEX_COMMAND: command }, `
      import { resolveCodexCommand, resolvePinnedCodexCommand } from ${JSON.stringify(resolver)};
      import { execFileSync } from "node:child_process";
      import assert from "node:assert/strict";
      assert.equal(resolveCodexCommand(), ${JSON.stringify(command)});
      assert.equal(resolvePinnedCodexCommand(), ${JSON.stringify(command)});
      process.stdout.write(execFileSync(resolveCodexCommand(), ["--version"]));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "composer-stop-fixture");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const env of [{}, { PAPERCLIP_STOP_CODEX_COMMAND: "codex" }, { NODE_ENV: "production", PAPERCLIP_STOP_CODEX_COMMAND: process.execPath }]) {
  test(`rejects a missing or unsafe fixture configuration: ${JSON.stringify(env)}`, () => {
    const result = launch(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Composer Stop requires an absolute fixture command/);
  });
}
