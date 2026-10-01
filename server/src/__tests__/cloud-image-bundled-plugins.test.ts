import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_CATALOG } from "../services/bundled-plugins.js";

/**
 * Drift guard for the explicit preview image (Dockerfile `cloud` target).
 *
 * The preview image builds the plugins named in the
 * CLOUD_BUNDLED_PLUGINS build arg so managed instances can auto-install
 * them from the bundled catalog at boot. The Dockerfile default and
 * BUNDLED_PLUGIN_CATALOG must agree even after the recurring public cloud
 * publisher is retired. Explicit previews still use this build target.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");

function parseList(source: string, pattern: RegExp, label: string): string[] {
  const match = source.match(pattern);
  expect(match, `${label} must declare CLOUD_BUNDLED_PLUGINS`).toBeTruthy();
  const names = (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  expect(names.length, `${label} CLOUD_BUNDLED_PLUGINS must not be empty`).toBeGreaterThan(0);
  return names;
}

const dockerfileDefault = parseList(
  dockerfile,
  /^ARG CLOUD_BUNDLED_PLUGINS="([^"]*)"/m,
  "Dockerfile",
);

describe("cloud image bundled plugins", () => {
  function runPluginBuild(names: string) {
    const directory = mkdtempSync(path.join(tmpdir(), "cloud-plugin-paths-"));
    try {
      // Traversal destinations exist, so rejection cannot pass only because a
      // directory is missing. The installer must never see those entries.
      for (const relative of ["sandbox-providers/daytona", "examples/search", "sandbox-providers/examples", "escape"]) {
        mkdirSync(path.join(directory, "packages/plugins", relative), { recursive: true });
      }
      const bin = path.join(directory, "bin");
      mkdirSync(bin);
      // Only package installation/build is stubbed. Execute the real Docker RUN
      // command so the regression exercises its path resolution and validation.
      writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh
set -eu
test "$1" = "-C"
printf '%s:%s\\n' "$2" "$3" >> "$PLUGIN_TEST_CALLS"
if [ "$3" = "build" ]; then
  mkdir -p "$2/dist"
  touch "$2/dist/manifest.js"
fi
`, { mode: 0o755 });
      const command = dockerfile.match(/FROM build AS cloud-plugins\nARG CLOUD_BUNDLED_PLUGINS="[^\n]*"\nRUN ([\s\S]*?\n  done)/)?.[1];
      expect(command, "cloud-plugins must retain its build command").toBeTruthy();
      const calls = path.join(directory, "calls");
      const result = spawnSync("sh", ["-c", command!], { cwd: directory, encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLOUD_BUNDLED_PLUGINS: names, PLUGIN_TEST_CALLS: calls } });
      return { status: result.status, stderr: result.stderr,
        calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [] };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  it("builds a path-form plugin and retains bare-name compatibility", () => {
    const result = runPluginBuild("daytona examples/search");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([
      "packages/plugins/sandbox-providers/daytona:install", "packages/plugins/sandbox-providers/daytona:build",
      "packages/plugins/examples/search:install", "packages/plugins/examples/search:build",
    ]);
    expect(dockerfile).toContain("COPY --chown=node:node --from=cloud-plugins /app/packages/plugins /app/packages/plugins\n");
  });

  it.each(["../escape", "examples/../../escape"])("rejects traversal before installation: %s", (name) => {
    const result = runPluginBuild(name);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("may not contain '..'");
    expect(result.calls).toEqual([]);
  });

  it.each(dockerfileDefault)(
    "plugin %s is buildable and resolvable by the auto-installer",
    (name) => {
      const relative = name.includes("/") ? name : `sandbox-providers/${name}`;
      const dir = path.join(repoRoot, "packages", "plugins", relative);
      expect(existsSync(dir), `${dir} must exist`).toBe(true);
      expect(
        existsSync(path.join(dir, "src", "manifest.ts")),
        `${name} must have src/manifest.ts so the build produces dist/manifest.js`,
      ).toBe(true);
      const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      expect(packageJson.scripts?.build, `${name} must have a build script`).toBeTruthy();

      // The auto-installer resolves catalog keys to relative paths; a plugin
      // baked into the image but absent from the catalog (or vice versa)
      // can never be auto-installed.
      const catalogEntry = BUNDLED_PLUGIN_CATALOG.find(
        (entry) => entry.relativePath === relative,
      );
      expect(catalogEntry, `${name} must be listed in BUNDLED_PLUGIN_CATALOG`).toBeTruthy();
    },
  );

  it("pins the default image build to the production target", () => {
    // The Dockerfile's final stage is `cloud`; without an explicit target
    // the workflow's main build would silently publish the cloud variant
    // to the self-hosted tags.
    expect(workflow).toMatch(/^\s*target: production$/m);
  });

  it("throttles the docker workflow with cancel-in-progress: false", () => {
    // Concurrency is declared at the workflow (top) level so a single group
    // spans the whole run, and cancel-in-progress is false so an in-flight
    // image build always finishes — a newer push only supersedes the pending
    // slot instead of killing the build that is already publishing.
    expect(workflow).toMatch(/^concurrency:$/m);
    // Pin the per-ref group key: without it the block could keep
    // cancel-in-progress: false yet lose the group that scopes serialization
    // to a single ref, silently changing which builds queue behind each other.
    expect(workflow).toContain("group: docker-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("cancel-in-progress: true");
  });
});
