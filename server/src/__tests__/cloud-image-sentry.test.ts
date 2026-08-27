import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the cloud image variant's bundled Sentry server package
 * (Dockerfile `cloud` target).
 *
 * The self-hosted image, built from the `production` target, keeps
 * `@sentry/node` as a true optional peer dependency: the operator installs
 * it themselves. The hosted (cloud) image installs the exact version
 * `server/package.json` declares, so a managed tenant gets server error
 * reports with no separate install step. This test pins two invariants
 * that nothing else ties together: every Dockerfile instruction that
 * installs `@sentry/node` sits strictly after the `production` stage body
 * ends, and the Dockerfile and the docker workflow carry no second,
 * hardcoded copy of the version.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");
const serverPackageJson = JSON.parse(
  readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"),
) as { peerDependencies?: Record<string, string> };

const declaredVersion = serverPackageJson.peerDependencies?.["@sentry/node"];

describe("cloud image Sentry install", () => {
  it("declares @sentry/node as an optional peer in server/package.json", () => {
    expect(
      declaredVersion,
      "server/package.json must declare @sentry/node as an optional peer",
    ).toBeTruthy();
  });

  it("installs @sentry/node only after the production stage body ends", () => {
    const stageHeaderPattern = /^FROM\s+\S+\s+AS\s+(\S+)/gim;
    const stages = [...dockerfile.matchAll(stageHeaderPattern)].map((match) => ({
      name: match[1],
      index: match.index ?? 0,
    }));

    const productionIndex = stages.findIndex((stage) => stage.name.toLowerCase() === "production");
    expect(productionIndex, "the Dockerfile must declare a production stage").toBeGreaterThanOrEqual(0);

    // The next declared stage after `production` marks where its body ends.
    const productionBodyEnd = stages[productionIndex + 1]?.index ?? dockerfile.length;

    const sentryMentionOffsets = [...dockerfile.matchAll(/@sentry\/node/g)].map(
      (match) => match.index ?? 0,
    );
    expect(
      sentryMentionOffsets.length,
      "the Dockerfile must install @sentry/node somewhere, for the cloud image variant",
    ).toBeGreaterThan(0);

    for (const offset of sentryMentionOffsets) {
      expect(
        offset,
        "every @sentry/node mention must sit after the production stage body ends, " +
          "so the self-hosted target never installs it",
      ).toBeGreaterThanOrEqual(productionBodyEnd);
    }
  });

  it("copies the installed package into the cloud stage's server node_modules", () => {
    expect(dockerfile).toMatch(
      /^COPY --chown=node:node --from=[\w-]+ \S+ \S*server\/node_modules$/m,
    );
  });

  it("reads the installed version from server/package.json instead of a second hardcoded copy", () => {
    // Matches a literal pin such as "@sentry/node@10.71.0", not a shell
    // variable interpolation such as "@sentry/node@${version}".
    const versionPinPattern = /@sentry\/node@(\d[^\s"'`]*)/g;

    for (const source of [
      { label: "Dockerfile", text: dockerfile },
      { label: "docker workflow", text: workflow },
    ]) {
      for (const match of source.text.matchAll(versionPinPattern)) {
        expect(
          match[1],
          `${source.label} pins @sentry/node@${match[1]}, which must equal the declared ` +
            `optional peer version ${declaredVersion}`,
        ).toBe(declaredVersion);
      }
    }
  });
});
