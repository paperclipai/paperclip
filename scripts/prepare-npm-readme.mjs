import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM_README_ASSET_BASE_URL =
  "https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/assets/";

export function prepareNpmReadme(readme) {
  return readme.replace(
    /((?:src|srcset)=["'])([^"']*)(["'])/g,
    (_match, prefix, value, suffix) =>
      `${prefix}${value.replace(
        /(^|,\s*)doc\/assets\//g,
        `$1${NPM_README_ASSET_BASE_URL}`,
      )}${suffix}`,
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const [sourcePath, destinationPath] = process.argv.slice(2);
  if (!sourcePath || !destinationPath) {
    throw new Error("usage: prepare-npm-readme.mjs <source> <destination>");
  }

  writeFileSync(
    destinationPath,
    prepareNpmReadme(readFileSync(sourcePath, "utf8")),
  );
}
