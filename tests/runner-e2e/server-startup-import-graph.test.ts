import path from "node:path";
import { build, type Plugin } from "esbuild";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

// The source-server supervisor builds the plugin SDK (scripts/ensure-plugin-build-deps.mjs)
// before it starts Paperclip. Its own static imports load before that build, so they must
// never reach a workspace package whose entry point is generated output. When they did,
// every paid source cell failed with ERR_MODULE_NOT_FOUND before any test ran.
const BUILT_ONLY_PACKAGES = ["@paperclipai/plugin-sdk"];

async function staticImportPath(entry: string, target: string) {
  const reached = new Map<string, string>();
  const externalBare: Plugin = {
    name: "external-bare",
    setup(context) {
      context.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.startsWith("@paperclipai/") && !BUILT_ONLY_PACKAGES.some(name => args.path === name || args.path.startsWith(`${name}/`))) return undefined;
        if (args.path === target || args.path.startsWith(`${target}/`)) reached.set(args.path, args.importer);
        return { path: args.path, external: true };
      });
    },
  };
  const result = await build({
    entryPoints: [path.join(repositoryRoot, entry)], absWorkingDir: repositoryRoot,
    bundle: true, write: false, metafile: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [externalBare],
  });
  if (!reached.size) return null;
  const parents = new Map<string, string>([[entry, ""]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    for (const imported of result.metafile.inputs[file]?.imports ?? []) {
      if (imported.external || parents.has(imported.path)) continue;
      parents.set(imported.path, file);
      queue.push(imported.path);
    }
  }
  const importer = path.relative(repositoryRoot, [...reached.values()][0]!);
  const chain = [target, importer];
  for (let file = parents.get(importer); file; file = parents.get(file)) chain.push(file);
  return chain.reverse().join(" -> ");
}

describe("runner E2E source-server supervisor", () => {
  it.each(BUILT_ONLY_PACKAGES)("loads without the generated %s output", async name => {
    expect(await staticImportPath("tests/runner-e2e/server.ts", name)).toBeNull();
  }, 60_000);
});
