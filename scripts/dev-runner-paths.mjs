const testDirectoryNames = new Set([
  "__tests__",
  "_tests",
  "test",
  "tests",
]);

const ignoredTestConfigBasenames = new Set([
  "jest.config.cjs",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.ts",
  "playwright.config.ts",
  "vitest.config.ts",
]);

// iCloud Drive sync creates/touches metadata files in any synced directory
// (including our _paperclip source tree when it lives under
// ~/Library/Mobile Documents/com~apple~CloudDocs/...). Those metadata events
// were triggering false-positive dev-server restarts every few minutes —
// see raw/company/cos-plugin-verification-2026-04-17.md for impact log.
//
// We ignore:
//   - .DS_Store              (Finder metadata)
//   - *.icloud               (offloaded-file placeholders)
//   - ._*                    (AppleDouble sidecars)
//   - .Trashes, .Spotlight-* (OS-level)
//   - .git/*, node_modules/*, dist/* (standard dev noise we were already
//     mostly excluding via other means; belt-and-suspenders here)
const iCloudAndOsMetadataIgnoredBasenames = new Set([
  ".DS_Store",
]);

function isICloudOrOsMetadata(basename, segments) {
  if (iCloudAndOsMetadataIgnoredBasenames.has(basename)) return true;
  if (basename.endsWith(".icloud")) return true;
  if (basename.startsWith("._")) return true;
  if (basename.startsWith(".Spotlight-")) return true;
  if (basename === ".Trashes" || basename === ".TemporaryItems") return true;
  if (segments.includes(".git")) return true;
  if (segments.includes("node_modules")) return true;
  if (segments.includes("dist")) return true;
  return false;
}

export function shouldTrackDevServerPath(relativePath) {
  const normalizedPath = String(relativePath).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalizedPath.length === 0) return false;

  const segments = normalizedPath.split("/");
  const basename = segments.at(-1) ?? normalizedPath;

  if (segments.includes(".paperclip")) {
    return false;
  }
  if (isICloudOrOsMetadata(basename, segments)) {
    return false;
  }
  if (ignoredTestConfigBasenames.has(basename)) {
    return false;
  }
  if (segments.some((segment) => testDirectoryNames.has(segment))) {
    return false;
  }
  if (/\.(test|spec)\.[^/]+$/i.test(basename)) {
    return false;
  }

  return true;
}
