import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("dependency-layer inputs can run both Copilot postinstall entrypoints before compilation", async () => {
  const dockerfile = await readFile(path.join(repo, "Dockerfile"), "utf8");
  const stage = dockerfile.split(/^FROM .* AS deps\s*$/im)[1]?.split(/^FROM /im)[0];
  assert.ok(stage, "dependency stage exists");
  const beforeInstall = stage.split(/^RUN pnpm install/m)[0];
  const fixture = await mkdtemp(path.join(tmpdir(), "paperclip-docker-postinstall-"));
  try {
    for (const line of beforeInstall.split("\n")) {
      if (!line.startsWith("COPY ") || line.includes("--")) continue;
      const args = line.trim().split(/\s+/).slice(1);
      const destination = args.pop();
      for (const source of args) {
        if (source !== "pnpm-workspace.yaml"
          && !source.startsWith("packages/paperclip-runner/")
          && !source.startsWith("server/")) continue;
        assert.ok(destination.endsWith("/"), "fixture supports directory COPY destinations");
        const target = path.join(fixture, destination, path.basename(source));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(path.join(repo, source), target, { recursive: true });
      }
    }
    for (const owner of ["packages/paperclip-runner", "server"]) {
      const cwd = path.join(fixture, owner);
      const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
      assert.equal(manifest.scripts.postinstall, "node scripts/install-copilot-assets.mjs");
      const output = execFileSync(process.execPath, ["scripts/install-copilot-assets.mjs"], {
        cwd, encoding: "utf8", timeout: 10_000,
      });
      assert.match(output, /Copilot runtime assets: (source-workspace-pending-build|unsupported-platform)/);
      await assert.rejects(readFile(path.join(cwd, "provider-assets/copilot")), { code: "ENOENT" });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
