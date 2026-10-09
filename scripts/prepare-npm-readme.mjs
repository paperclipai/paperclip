import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function prepareNpmReadme(readme, assetRef) {
  if (!assetRef) {
    throw new Error("an immutable README asset ref is required");
  }

  const assetBaseUrl =
    `https://raw.githubusercontent.com/paperclipai/paperclip/${assetRef}/doc/assets/`;

  return readme.replace(
    /((?:src|srcset)=["'])([^"']*)(["'])/g,
    (_match, prefix, value, suffix) =>
      `${prefix}${value.replace(
        /(^|,\s*)doc\/assets\//g,
        `$1${assetBaseUrl}`,
      )}${suffix}`,
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const [sourcePath, destinationPath, assetRef] = process.argv.slice(2);
  if (!sourcePath || !destinationPath || !assetRef) {
    throw new Error(
      "usage: prepare-npm-readme.mjs <source> <destination> <asset-ref>",
    );
  }

  writeFileSync(
    destinationPath,
    prepareNpmReadme(readFileSync(sourcePath, "utf8"), assetRef),
  );
}
