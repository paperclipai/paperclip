import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledPluginRuntimeLoader(
  moduleDirectory = path.dirname(fileURLToPath(import.meta.url)),
): string {
  let directory = fs.realpathSync(moduleDirectory);
  let imageRoot: string | undefined;
  for (let depth = 0; depth < 5; depth++) {
    const metadataPath = path.join(directory, "package.json");
    const metadata = fs.lstatSync(metadataPath, { throwIfNoEntry: false });
    if (metadata?.isFile() && metadata.size <= 128 * 1024
      && JSON.parse(fs.readFileSync(metadataPath, "utf8")).name === "@paperclipai/server") {
      imageRoot = path.dirname(directory);
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!imageRoot) throw new Error("Managed plugin server package is missing from the current image");
  const declared = path.join(imageRoot, "cli/node_modules/tsx/dist/loader.mjs");
  let loader: string;
  try {
    loader = fs.realpathSync(declared);
    if (!fs.statSync(loader).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("Managed plugin runtime loader is missing from the current image");
  }
  const roots = [path.join(imageRoot, "cli"), path.join(imageRoot, "node_modules")];
  if (!roots.some((root) => {
    const relative = path.relative(root, loader);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  })) throw new Error("Managed plugin runtime loader escapes the current image");
  return loader;
}
