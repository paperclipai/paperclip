// Package-contract tests exercise patched ACPX internals that the package does
// not export publicly. Bundled chunks re-export them under minified aliases
// that change on every release, so resolve each one by its source name from
// the chunk's export map instead of pinning a chunk file or alias letter.
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export function acpxPackageRoot() {
  return process.env.PAPERCLIP_TEST_ACPX_PACKAGE_ROOT ?? dirname(require.resolve("acpx/package.json"));
}

function exportMap(source) {
  const statement = source.match(/^export \{([^}]*)\};\s*(?:\/\/#.*)?\s*$/m);
  if (!statement) return new Map();
  return new Map(statement[1].split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [local, alias = local] = entry.split(/\s+as\s+/);
    return [local, alias];
  }));
}

/** Absolute paths of the chunks that define and export each requested name. */
export async function acpxBundleChunks(names, root = acpxPackageRoot()) {
  const dist = join(root, "dist");
  const located = new Map();
  for (const file of (await readdir(dist)).filter((name) => name.endsWith(".js")).sort()) {
    const path = join(dist, file);
    const exported = exportMap(await readFile(path, "utf8"));
    for (const name of names) if (!located.has(name) && exported.has(name)) located.set(name, { path, alias: exported.get(name) });
  }
  const missing = names.filter((name) => !located.has(name));
  if (missing.length > 0) throw new Error(`ACPX bundle does not export ${missing.join(", ")}`);
  return located;
}

/** Imports named ACPX internals, e.g. `const { AcpClient } = await acpxInternals(["AcpClient"])`. */
export async function acpxInternals(names, root = acpxPackageRoot()) {
  const located = await acpxBundleChunks(names, root);
  const result = {};
  for (const [name, { path, alias }] of located) result[name] = (await import(pathToFileURL(path).href))[alias];
  return result;
}

/** Source text of the chunk that defines `name`, for structural assertions. */
export async function acpxChunkSource(name, root = acpxPackageRoot()) {
  const located = await acpxBundleChunks([name], root);
  return await readFile(located.get(name).path, "utf8");
}
