import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * Drift guard for the layers of the production image that must stay identical
 * between commits.
 *
 * Installed dependencies (~2.9 GB) and the large provider-pack binaries
 * (~2.5 GB) change only when the lockfile or a provider version changes. When
 * they shared a layer with files that change on every commit, each master
 * build pushed about 3.5 GB of unchanged bytes and each deploy pulled them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

function stageBody(stageName: string): string {
  const froms = [...dockerfile.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\s*$`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  return dockerfile.slice(froms[startIdx].index ?? 0, froms[startIdx + 1]?.index ?? dockerfile.length);
}

it("copies installed dependencies as their own layer, before the per-commit app files", () => {
  const production = stageBody("production");
  const dependencies = production.search(/^COPY --chown=node:node --from=deps \/app\/node_modules \/app\/node_modules$/m);
  const app = production.search(/^COPY --chown=node:node --exclude=node_modules --from=build \/app \/app$/m);
  expect(dependencies, "dependencies must come from the deps stage").toBeGreaterThanOrEqual(0);
  expect(app, "the app copy must leave out the root node_modules").toBeGreaterThan(dependencies);
  // A copy of all of /app from the build stage would put the dependencies
  // back into the per-commit layer.
  expect(production).not.toMatch(/^COPY (?!.*--exclude=node_modules).*--from=build \/app \/app$/m);
});

it("copies the large provider-pack files as a linked layer with fixed timestamps", () => {
  const pack = stageBody("runner-provider-pack");
  const archive = pack.indexOf("create-provider-pack-archive.mjs");
  const split = pack.indexOf("mv \"$1\" \"/provider-pack-large/$1\"");
  const timestamps = pack.indexOf("find /provider-pack-large -exec touch -h -d @0 {} +");
  // The transport archive reads the whole pack, so the split must follow it.
  expect(archive).toBeGreaterThanOrEqual(0);
  expect(split).toBeGreaterThan(archive);
  expect(timestamps).toBeGreaterThan(split);

  const production = stageBody("production");
  const large = production.search(
    /^COPY --link --chown=0:0 --from=runner-provider-pack \/provider-pack-large\/ \/opt\/paperclip-runner\/provider-pack\/$/m,
  );
  const rest = production.search(
    /^COPY --chown=0:0 --from=runner-provider-pack \/provider-pack \/opt\/paperclip-runner\/provider-pack$/m,
  );
  expect(large, "large files need --link so the layer does not depend on the app layer").toBeGreaterThanOrEqual(0);
  expect(rest).toBeGreaterThan(large);
});
