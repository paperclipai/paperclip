import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type ReadTextFile = (path: string) => string;

// The build version stamp is computed by CI on the build runner (where `.git`
// exists) and baked into the image, so a running container reports the real
// version instead of the source `package.json` placeholder. It is typically the
// raw `git describe` output, e.g. "v2026.722.0-15-g4c55f0d"; version.ts runs it
// through the same parser used for a live checkout. A resolved version set
// directly is accepted verbatim.
const DEFAULT_BUILD_VERSION_PATH = fileURLToPath(
  new URL("../../.paperclip-build-version", import.meta.url),
);

export function parseBuildVersion(value: string | null | undefined): string | null {
  const version = value?.trim() ?? "";
  // A version/describe string is a single token: reject empties and anything
  // carrying whitespace so a stray file cannot inject a multi-line value.
  if (!version || /\s/.test(version)) return null;
  return version;
}

export function readBuildVersion(
  opts: {
    environmentVersion?: string | null;
    buildVersionPath?: string;
    readTextFile?: ReadTextFile;
  } = {},
): string | null {
  const environmentVersion = parseBuildVersion(
    opts.environmentVersion === undefined
      ? process.env.PAPERCLIP_BUILD_VERSION
      : opts.environmentVersion,
  );
  if (environmentVersion) return environmentVersion;

  try {
    const readTextFile =
      opts.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
    return parseBuildVersion(readTextFile(opts.buildVersionPath ?? DEFAULT_BUILD_VERSION_PATH));
  } catch {
    return null;
  }
}
