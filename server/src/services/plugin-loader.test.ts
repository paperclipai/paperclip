/**
 * Regression tests for PLA-159 — plugin manifest re-import must not return
 * stale, ESM-cache-pinned content when the underlying file is rebuilt.
 *
 * The bug: `await import('/.../dist/manifest.js')` is keyed by absolute
 * specifier in Node's ESM loader cache, so every install/upgrade against
 * the same path returned the originally-imported module for the lifetime
 * of the host process. Fix: cache-bust via `?mtime=...` on the file URL.
 *
 * The "install → overwrite → upgrade → assert-new-tool" scenario from the
 * ticket reduces to this: `loadManifestModule` must observe the rewritten
 * file. If it does, install and upgrade both pass the fresh manifest to
 * `registry.install` / `registry.update`, which write `manifestJson`
 * verbatim — `activatePlugin` (`const manifest = plugin.manifestJson`)
 * then sees the on-disk contents, satisfying AC #3.
 */
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { loadManifestModule } from "./plugin-loader.js";
import { pluginManifestValidator } from "./plugin-manifest-validator.js";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "pla-159-manifest-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Write a manifest module file with the given tool name and bump its mtime
 * so the cache-bust query string changes between iterations of the same path.
 */
async function writeManifestWithTool(
  manifestPath: string,
  toolName: string,
  mtimeSec: number,
): Promise<void> {
  const body = `export default ${JSON.stringify({
    apiVersion: 1,
    id: "test.pla159",
    version: "1.0.0",
    displayName: "PLA-159 Fixture",
    description: "manifest used by plugin-loader regression tests",
    capabilities: ["agent.tools.register"],
    categories: [],
    tools: [
      {
        name: toolName,
        displayName: toolName,
        description: `tool ${toolName}`,
        parametersSchema: { type: "object", properties: {} },
      },
    ],
  })};\n`;
  await writeFile(manifestPath, body, "utf8");
  // Force a distinct mtime so the cache-bust URL differs between writes,
  // even on filesystems where back-to-back writes can land in the same ms.
  await utimes(manifestPath, mtimeSec, mtimeSec);
}

describe("plugin-loader / loadManifestModule (PLA-159)", () => {
  it("returns the freshly-rewritten manifest from the same path on re-import", async () => {
    const manifestPath = path.join(workDir, "manifest-cache-bust.js");

    await writeManifestWithTool(manifestPath, "foo", 1_700_000_000);
    const first = (await loadManifestModule(manifestPath)) as {
      tools: { name: string }[];
    };
    expect(first.tools[0]?.name).toBe("foo");

    await writeManifestWithTool(manifestPath, "bar", 1_700_000_001);
    const second = (await loadManifestModule(manifestPath)) as {
      tools: { name: string }[];
    };

    // Without the cache-bust, this would still be 'foo' — the original
    // bug per PLA-159. With the fix, the rewritten file wins.
    expect(second.tools[0]?.name).toBe("bar");
  });

  it("reuses the cached import when the file has not changed (no perf regression)", async () => {
    const manifestPath = path.join(workDir, "manifest-cached.js");

    await writeManifestWithTool(manifestPath, "stable", 1_700_000_100);
    const first = await loadManifestModule(manifestPath);
    const second = await loadManifestModule(manifestPath);

    // Same URL → ESM loader returns the same module namespace identity.
    expect(second).toBe(first);
  });
});

describe("plugin-manifest-validator (PLA-159 roll-in)", () => {
  const baseManifest = {
    apiVersion: 1,
    id: "test.validator",
    version: "1.0.0",
    displayName: "Validator Fixture",
    description: "manifest used by validator regression tests",
    author: "Paperclip Tests",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
  };

  it("rejects tool names containing ':' via the allowlist regex with a name-targeted error", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse({
      ...baseManifest,
      tools: [
        {
          name: "cad:run_script",
          displayName: "Run script",
          description: "runs a script",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    // The allowlist regex on pluginToolDeclarationSchema.name produces a
    // shape-focused error message — the colon is rejected because it is
    // not in `[a-z0-9._-]`, alongside whitespace, control chars, path
    // separators, and unicode lookalikes.
    expect(result.errors.toLowerCase()).toContain("tool name");
    expect(result.errors).toContain("lowercase");
    // And targets the offending field path so UIs can highlight it.
    expect(
      result.details.some(
        (d) =>
          d.path[0] === "tools" && d.path[1] === 0 && d.path[2] === "name",
      ),
    ).toBe(true);
  });

  it("rejects tool names with whitespace, uppercase, or path separators", () => {
    const validator = pluginManifestValidator();
    for (const badName of ["Run Script", "RUN_SCRIPT", "run script", "run/script", "run\\script", " run", "run\t"]) {
      const result = validator.parse({
        ...baseManifest,
        tools: [
          {
            name: badName,
            displayName: "Run script",
            description: "runs a script",
            parametersSchema: { type: "object", properties: {} },
          },
        ],
      });
      expect(result.success, `should reject ${JSON.stringify(badName)}`).toBe(false);
    }
  });

  it("accepts bare lowercase tool names within the allowlist", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse({
      ...baseManifest,
      tools: [
        {
          name: "run_script",
          displayName: "Run script",
          description: "runs a script",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});
