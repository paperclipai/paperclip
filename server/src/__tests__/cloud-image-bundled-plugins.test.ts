import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLED_PLUGIN_CATALOG } from "../services/bundled-plugins.js";

/**
 * Drift guard for the cloud image variant (Dockerfile `cloud` target).
 *
 * The cloud image builds the sandbox-provider plugins named in the
 * CLOUD_BUNDLED_PLUGINS build arg so managed instances can auto-install
 * them from the bundled catalog at boot. That contract spans three places
 * that nothing else ties together: the Dockerfile ARG default, the docker
 * workflow's build-arg, and BUNDLED_PLUGIN_CATALOG. A rename or removal in
 * any one of them would otherwise surface only when the image build fails
 * on master — or worse, as a silent "bundle not present" skip at instance
 * boot.
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
const workflowArg = parseList(
  workflow,
  /^\s*CLOUD_BUNDLED_PLUGINS=(.*)$/m,
  "docker workflow",
);

describe("cloud image bundled plugins", () => {
  it("keeps the Dockerfile default and the workflow build-arg in sync", () => {
    expect(workflowArg).toEqual(dockerfileDefault);
  });

  it.each([...new Set([...dockerfileDefault, ...workflowArg])])(
    "plugin %s is buildable and resolvable by the auto-installer",
    (name) => {
      const dir = path.join(repoRoot, "packages", "plugins", "sandbox-providers", name);
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
        (entry) => entry.relativePath === `sandbox-providers/${name}`,
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

  it("publishes the cloud image in its own job with no needs coupling", () => {
    // The cloud publish runs as its own top-level job so the stock/production
    // publish can never gate, delay, or skip it. Both jobs share only the
    // single top-level concurrency slot; there is deliberately no `needs:`
    // between them, so a failure in one is never coupled to the other.
    const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
    const headers = [...jobsSection.matchAll(/^ {2}([\w-]+):[^\n]*$/gm)];
    expect(
      headers.length,
      "docker.yml must declare at least two jobs under jobs:",
    ).toBeGreaterThanOrEqual(2);

    // Locate the job block that carries the cloud build (target: cloud) and
    // assert it declares no `needs:` — coupling it to another job would
    // reintroduce the shared failure the split job exists to remove.
    const cloudHeaderIdx = headers.findIndex((header, i) => {
      const start = header.index ?? 0;
      const end = headers[i + 1]?.index ?? jobsSection.length;
      return jobsSection.slice(start, end).includes("target: cloud");
    });
    expect(cloudHeaderIdx, "one job must build the cloud target").toBeGreaterThanOrEqual(0);
    const start = headers[cloudHeaderIdx].index ?? 0;
    const end = headers[cloudHeaderIdx + 1]?.index ?? jobsSection.length;
    const cloudJobBlock = jobsSection.slice(start, end);
    expect(
      cloudJobBlock,
      "the cloud job must not couple to another job via needs:",
    ).not.toMatch(/^\s*needs:/m);
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
